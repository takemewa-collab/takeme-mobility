// ═══════════════════════════════════════════════════════════════════════════
// TakeMe production E2E — driver lifecycle + payment settlement.
// Secrets are read from the platform's .env.local and NEVER printed; output
// is pass/fail assertions only.
//
// Driver = the owner's real activated driver account (EFE ACIL / RAV4).
// Rider  = the owner's second account (acilholding@gmail.com).
// Stripe is in TEST mode (pk_test/sk_test) — confirmed with the test card.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const HOME = process.env.HOME;
const env = {};
for (const line of readFileSync(`${HOME}/Projects/takeme-mobility/.env.local`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=["']?(.*?)["']?\s*$/);
  if (m) env[m[1]] = m[2];
}

const BASE = 'https://www.takememobility.com';
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const DRIVER_UID = 'd6d9b86a-9a78-43b6-b826-3c620f104cd8'; // EFE ACIL (driver)
const DRIVER_ROW = 'ecd8936d-a36c-4f0c-9022-c4bad60160ab';
const RIDER_UID = 'ad70aa98-dd02-45cd-b0bd-00404facb84d'; // second account (rider)

const PICKUP = { lat: 47.6097, lng: -122.3331, address: '400 Pine St, Seattle, WA' };
const DROPOFF = { lat: 47.6205, lng: -122.3493, address: '305 Harrison St, Seattle, WA' };

const admin = createClient(SUPA_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✘ ${name} ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mintSession(userId, email) {
  const { data: userData } = await admin.auth.admin.getUserById(userId);
  if (!userData?.user?.email) {
    const { error } = await admin.auth.admin.updateUserById(userId, { email, email_confirm: true });
    if (error) throw new Error(`updateUser: ${error.message}`);
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const tokenHash = data.properties?.hashed_token;
  const res = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`verify failed: ${JSON.stringify(j).slice(0, 160)}`);
  return j.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

async function stripe(method, path, form) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return res.json();
}

async function waitFor(desc, fn, { tries = 20, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delayMs);
  }
  return null;
}

async function bookRide(riderToken) {
  // Quote
  const q = await api(riderToken, 'POST', '/api/quotes', {
    pickup: PICKUP, dropoff: DROPOFF,
  });
  if (q.status !== 200) throw new Error(`quote failed ${q.status}: ${JSON.stringify(q.json).slice(0, 200)}`);
  const economy = q.json.quotes.find((x) => x.vehicleClass === 'economy') ?? q.json.quotes[0];
  const route = q.json.route;

  // Authorize payment
  const ps = await api(riderToken, 'POST', '/api/mobile/payment-sheet', {
    amount: String(economy.totalFare),
  });
  if (ps.status !== 200) throw new Error(`payment-sheet ${ps.status}: ${JSON.stringify(ps.json).slice(0, 200)}`);
  const confirmed = await stripe('POST', `/payment_intents/${ps.json.paymentIntentId}/confirm`, {
    payment_method: 'pm_card_visa',
  });
  if (confirmed.status !== 'requires_capture') {
    throw new Error(`PI confirm → ${confirmed.status ?? JSON.stringify(confirmed).slice(0, 160)}`);
  }

  // Create ride
  const created = await api(riderToken, 'POST', '/api/rides/create', {
    pickupAddress: route.pickupAddress ?? PICKUP.address,
    pickupLat: route.pickupLat, pickupLng: route.pickupLng,
    dropoffAddress: route.dropoffAddress ?? DROPOFF.address,
    dropoffLat: route.dropoffLat, dropoffLng: route.dropoffLng,
    distanceKm: route.distanceKm, durationMin: route.durationMin,
    ...(route.polyline ? { polyline: route.polyline } : {}),
    vehicleClass: 'economy',
    baseFare: economy.baseFare, distanceFare: economy.distanceFare,
    timeFare: economy.timeFare, totalFare: economy.totalFare,
    surgeMultiplier: economy.surgeMultiplier ?? 1.0,
    currency: 'USD',
    paymentIntentId: ps.json.paymentIntentId,
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`rides/create ${created.status}: ${JSON.stringify(created.json).slice(0, 300)}`);
  }
  const rideId = created.json.ride?.id ?? created.json.rideId ?? created.json.id;
  if (!rideId) throw new Error(`no ride id in ${JSON.stringify(created.json).slice(0, 200)}`);
  return { rideId, paymentIntentId: ps.json.paymentIntentId, fare: economy.totalFare };
}

const offerSentTo = async (rideId) => {
  const { data } = await admin
    .from('ride_events').select('metadata, event_type')
    .eq('ride_id', rideId).eq('event_type', 'offer_sent');
  return data?.some((e) => e.metadata?.driver_id === DRIVER_ROW) ? data : null;
};

// ═══ Run ════════════════════════════════════════════════════════════════
console.log('— minting sessions —');
const driverToken = await mintSession(DRIVER_UID, 'takemewa@gmail.com');
const riderToken = await mintSession(RIDER_UID, 'acilholding@gmail.com');
console.log('  sessions ok');

console.log('— driver auth + activation —');
const st = await api(driverToken, 'GET', '/api/driver/status');
check('GET /api/driver/status 200', st.status === 200, `got ${st.status}`);
check('driver profile is EFE ACIL row', st.json?.driver?.id === DRIVER_ROW, JSON.stringify(st.json).slice(0, 120));

console.log('— go online (production activation gate) —');
const on = await api(driverToken, 'PUT', '/api/driver/status', { status: 'available' });
check('PUT status available 200', on.status === 200, JSON.stringify(on.json).slice(0, 200));

console.log('— location heartbeat (map telemetry) —');
const loc = await api(driverToken, 'POST', '/api/driver/location', {
  lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, heading: 90,
});
check('POST /api/driver/location 200', loc.status === 200, JSON.stringify(loc.json).slice(0, 120));
const { data: dl } = await admin.from('driver_locations').select('driver_id, updated_at').eq('driver_id', DRIVER_ROW).maybeSingle();
check('driver_locations row fresh', dl != null && Date.now() - new Date(dl.updated_at).getTime() < 60_000);

console.log('— ride 1: book → offer → accept → trip → complete → capture —');
const { data: walletBefore } = await admin.from('driver_wallets').select('available, lifetime').eq('driver_id', DRIVER_UID).maybeSingle();
const availBefore = Number(walletBefore?.available ?? 0);
const ride1 = await bookRide(riderToken);
console.log(`  ride ${ride1.rideId} fare $${ride1.fare}`);
const offered = await waitFor('offer_sent', () => offerSentTo(ride1.rideId));
check('dispatch offered ride to our driver', offered != null);

const accept = await api(driverToken, 'PUT', '/api/driver/rides', { rideId: ride1.rideId, action: 'accept' });
check('accept → driver_assigned', accept.status === 200 && accept.json?.status === 'driver_assigned', JSON.stringify(accept.json).slice(0, 160));

const g1 = await api(driverToken, 'GET', '/api/driver/rides');
check('GET driver ride returns assigned ride', g1.json?.ride?.id === ride1.rideId);

const arr = await api(driverToken, 'PUT', '/api/driver/rides', { rideId: ride1.rideId, action: 'arrived' });
check('arrived ok', arr.status === 200, JSON.stringify(arr.json).slice(0, 120));
const start = await api(driverToken, 'PUT', '/api/driver/rides', { rideId: ride1.rideId, action: 'start_trip' });
check('start_trip ok', start.status === 200, JSON.stringify(start.json).slice(0, 120));
const { data: dOnTrip } = await admin.from('drivers').select('status').eq('id', DRIVER_ROW).single();
check('driver status on_trip during trip', dOnTrip?.status === 'on_trip', dOnTrip?.status);

const done = await api(driverToken, 'PUT', '/api/driver/rides', { rideId: ride1.rideId, action: 'complete' });
check('complete ok', done.status === 200, JSON.stringify(done.json).slice(0, 120));

const pay1 = await waitFor('payment captured', async () => {
  const { data } = await admin.from('payments').select('status, amount').eq('ride_id', ride1.rideId).maybeSingle();
  return data?.status === 'captured' ? data : null;
}, { tries: 10, delayMs: 1000 });
check('payments row captured', pay1 != null, JSON.stringify(pay1));
const pi1 = await stripe('GET', `/payment_intents/${ride1.paymentIntentId}`);
check('Stripe PI succeeded (funds captured)', pi1.status === 'succeeded', pi1.status);
const { data: r1 } = await admin.from('rides').select('status, final_fare').eq('id', ride1.rideId).single();
check('ride completed with final_fare', r1?.status === 'completed' && Number(r1?.final_fare) > 0, JSON.stringify(r1));
const { data: dAfter } = await admin.from('drivers').select('status').eq('id', DRIVER_ROW).single();
check('driver back to available after trip', dAfter?.status === 'available', dAfter?.status);

console.log('— driver earnings settlement —');
const expectedShare = Math.round(Number(pay1?.amount ?? 0) * 0.8 * 100) / 100;
const walletAfter = await waitFor('wallet credit', async () => {
  const { data } = await admin.from('driver_wallets').select('available, lifetime').eq('driver_id', DRIVER_UID).maybeSingle();
  return Number(data?.available ?? 0) > availBefore ? data : null;
}, { tries: 10, delayMs: 1000 });
check('driver wallet credited', walletAfter != null, JSON.stringify(walletAfter));
if (walletAfter) {
  const delta = Math.round((Number(walletAfter.available) - availBefore) * 100) / 100;
  check(`wallet delta = 80% of fare ($${expectedShare})`, Math.abs(delta - expectedShare) < 0.011, `delta $${delta}`);
}
const { data: tx1 } = await admin.from('driver_transactions').select('type, amount, status').eq('ride_id', ride1.rideId).eq('type', 'ride_earning');
check('single ride_earning transaction logged', (tx1?.length ?? 0) === 1, JSON.stringify(tx1));

const dash = await api(driverToken, 'GET', '/api/driver/dashboard');
check('GET /api/driver/dashboard 200 with wallet', dash.status === 200 && dash.json?.wallet != null, `got ${dash.status}`);

console.log('— ride 2: book → offer → DECLINE → escalation exhausts → hold released —');
await api(driverToken, 'POST', '/api/driver/location', { lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, heading: 90 });
const ride2 = await bookRide(riderToken);
console.log(`  ride ${ride2.rideId}`);
const offered2 = await waitFor('offer_sent 2', () => offerSentTo(ride2.rideId));
check('second offer sent to our driver', offered2 != null);

const decline = await api(driverToken, 'PUT', '/api/driver/rides', { rideId: ride2.rideId, action: 'decline' });
check('decline → {status declined}', decline.status === 200 && decline.json?.status === 'declined', JSON.stringify(decline.json).slice(0, 160));
const { data: ev2 } = await admin.from('ride_events').select('event_type').eq('ride_id', ride2.rideId).eq('event_type', 'offer_declined');
check('offer_declined event logged', (ev2?.length ?? 0) > 0);

// Declined driver must not be re-offered; with no other drivers the dispatch
// escalates and finally cancels. Wait through 3 × 15s windows.
const cancelled = await waitFor('ride 2 cancelled', async () => {
  const { data } = await admin.from('rides').select('status, cancelled_reason').eq('id', ride2.rideId).single();
  return data?.status === 'cancelled' ? data : null;
}, { tries: 40, delayMs: 3000 });
check('ride 2 cancelled by dispatch exhaustion', cancelled != null, JSON.stringify(cancelled));
if (cancelled) check('cancel reason no_drivers_available', cancelled.cancelled_reason === 'no_drivers_available', cancelled.cancelled_reason);
const pi2 = await stripe('GET', `/payment_intents/${ride2.paymentIntentId}`);
check('ride 2 card hold RELEASED (PI canceled)', pi2.status === 'canceled', pi2.status);
const reoffered = await admin.from('ride_events').select('id, metadata').eq('ride_id', ride2.rideId).eq('event_type', 'offer_sent');
check('declined driver not re-offered', (reoffered.data ?? []).filter((e) => e.metadata?.driver_id === DRIVER_ROW).length === 1);

console.log('— go offline —');
const off = await api(driverToken, 'PUT', '/api/driver/status', { status: 'offline' });
check('PUT status offline 200', off.status === 200);
const { data: dOff } = await admin.from('drivers').select('status').eq('id', DRIVER_ROW).single();
check('drivers.status offline', dOff?.status === 'offline', dOff?.status);

console.log('— stripe webhook registration (test mode) —');
const hooks = await stripe('GET', '/webhook_endpoints?limit=10');
for (const h of hooks.data ?? []) {
  console.log(`  endpoint ${h.url} status=${h.status} events=${(h.enabled_events ?? []).slice(0, 6).join(',')}${(h.enabled_events?.length ?? 0) > 6 ? ',…' : ''}`);
}
check('a webhook endpoint targets takememobility.com', (hooks.data ?? []).some((h) => h.url.includes('takememobility.com') && h.status === 'enabled'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('FAILED: ' + failures.join(' | '));
process.exit(fail === 0 ? 0 : 1);
