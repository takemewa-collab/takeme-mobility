/**
 * Incoming-offer alert: the loud, repeating TAKEME ride-request sound plus a
 * strong vibration pattern while a live offer is on screen.
 *
 * Lifecycle rules (production-critical):
 *  - ONE alert at a time, keyed by ride id — push and poll delivering the same
 *    offer must never double the sound.
 *  - stop() is idempotent and always safe; every terminal path (accept,
 *    decline, expiry, reassignment, screen unmount, sign-out) calls it.
 *  - The sound respects the in-app "Ride request sound" setting; vibration
 *    always fires so a muted preference never silently kills the alert.
 *  - Playback is foreground-only by design: when the app is backgrounded or
 *    the phone is locked, the high-priority push (custom sound, time-sensitive
 *    interruption level) is the alert channel. iOS silent-mode/Focus limits
 *    apply to pushes and cannot be bypassed without Apple's Critical Alerts
 *    entitlement, which this app does not claim.
 */

import { Audio } from 'expo-av';
import { Vibration, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const SOUND_SETTING_KEY = 'ride_alert_sound_enabled';

// 3 strong buzzes, pause, repeat (Android honors the full pattern natively;
// iOS gets a fixed-length buzz per vibrate() call, re-triggered on a timer).
const VIBRATION_PATTERN = [0, 400, 150, 400, 150, 400, 900];
const IOS_REVIBRATE_MS = 2400;

let sound: Audio.Sound | null = null;
let iosVibrateTimer: ReturnType<typeof setInterval> | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let alertingRideId: string | null = null;
let generation = 0;

export async function isAlertSoundEnabled(): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(SOUND_SETTING_KEY);
    return v !== 'off';
  } catch {
    return true;
  }
}

export async function setAlertSoundEnabled(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(SOUND_SETTING_KEY, enabled ? 'on' : 'off');
  } catch {
    // Non-fatal — the toggle just won't persist.
  }
}

/**
 * Start the alert for an offer. No-op when this ride is already alerting.
 * Returns whether the sound actually started (for observability acks).
 *
 * The alert is a module-level singleton that OWNS its own lifetime: it
 * auto-stops shortly after `expiresAtMs` no matter what happens to React
 * component lifecycles, so a remounting provider or a dropped state update
 * can never leave the sound playing past the offer window.
 */
export async function startOfferAlert(rideId: string, expiresAtMs?: number): Promise<boolean> {
  if (alertingRideId === rideId) return false;
  await stopOfferAlert();
  alertingRideId = rideId;
  const myGeneration = ++generation;

  if (expiresAtMs != null) {
    autoStopTimer = setTimeout(
      () => void stopOfferAlert(),
      Math.max(0, expiresAtMs - Date.now()) + 1500,
    );
  }

  // Vibration starts immediately — it must not wait on audio I/O.
  Vibration.vibrate(VIBRATION_PATTERN, Platform.OS === 'android');
  if (Platform.OS === 'ios') {
    iosVibrateTimer = setInterval(() => Vibration.vibrate(VIBRATION_PATTERN), IOS_REVIBRATE_MS);
  }

  if (!(await isAlertSoundEnabled())) return false;

  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      staysActiveInBackground: false,
    });
    const created = await Audio.Sound.createAsync(
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro bundles static assets via require()
      require('../../assets/sounds/ride_request.wav'),
      { isLooping: true, volume: 1.0 },
    );
    // The offer may have ended while the file loaded — never start late audio.
    if (myGeneration !== generation || alertingRideId !== rideId) {
      await created.sound.unloadAsync().catch(() => {});
      return false;
    }
    sound = created.sound;
    await sound.playAsync();
    return true;
  } catch (err) {
    console.warn('[offer-alert] sound failed to start (vibration still active):', err);
    return false;
  }
}

/** Stop everything. Idempotent; safe to call from any terminal path. */
export async function stopOfferAlert(): Promise<void> {
  generation += 1;
  alertingRideId = null;
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  Vibration.cancel();
  if (iosVibrateTimer) {
    clearInterval(iosVibrateTimer);
    iosVibrateTimer = null;
  }
  const s = sound;
  sound = null;
  if (s) {
    try {
      await s.stopAsync();
    } catch {
      // already stopped/unloaded
    }
    try {
      await s.unloadAsync();
    } catch {
      // already unloaded
    }
  }
}

export function currentAlertRideId(): string | null {
  return alertingRideId;
}
