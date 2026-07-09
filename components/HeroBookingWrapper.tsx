'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/context';
import { useGoogleMapsLoader } from '@/lib/useGoogleMapsLoader';
import { useDirections } from '@/lib/useDirections';
import { SEATTLE_TIERS, calculateAllFares, kmToMiles, PET_FEES, type VehicleClass, type FareResult, type PetSize } from '@/lib/seattle-pricing';

interface LatLng { lat: number; lng: number }
interface LocationState extends LatLng { address: string }

const SEATTLE_CENTER = { lat: 47.6062, lng: -122.3321 };

// ── Airport detection ────────────────────────────────────────────────────
const AIRPORT_KEYWORDS = ['airport', 'sea-tac', 'seatac', 'int\'l', 'intl', 'SEA ', 'boeing field', 'paine field'];

function isAirportAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return AIRPORT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

const AIRLINES = [
  'Alaska Airlines', 'Delta Air Lines', 'United Airlines', 'American Airlines',
  'Southwest Airlines', 'JetBlue Airways', 'Spirit Airlines', 'Frontier Airlines',
  'Hawaiian Airlines', 'Sun Country Airlines', 'Allegiant Air',
  'Air Canada', 'British Airways', 'Lufthansa', 'Emirates',
  'Korean Air', 'Japan Airlines', 'ANA', 'Cathay Pacific',
  'Singapore Airlines', 'Icelandair', 'Condor', 'Other',
];

const MAP_STYLES = [
  { featureType: 'all', elementType: 'labels.text.fill', stylers: [{ color: '#6E6E73' }] },
  { featureType: 'all', elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }, { weight: 3 }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#C8DDF0' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#EEEEF2' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#D2D2D7' }] },
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.local', elementType: 'geometry.fill', stylers: [{ color: '#F5F5F7' }] },
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#DDE8D6' }] },
  { featureType: 'transit', elementType: 'all', stylers: [{ visibility: 'off' }] },
];

export default function HeroBookingWrapper({ ctaHref }: { ctaHref: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const { ready: mapsReady, failed: mapsFailed } = useGoogleMapsLoader();

  const [pickup, setPickup] = useState<LocationState | null>(null);
  const [dropoff, setDropoff] = useState<LocationState | null>(null);
  const [pickupText, setPickupText] = useState('');
  const [dropoffText, setDropoffText] = useState('');
  const [selectedTier, setSelectedTier] = useState<VehicleClass>('electric');
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [bookingError, setBookingError] = useState('');
  const [selectedAirline, setSelectedAirline] = useState('');
  const [flightNumber, setFlightNumber] = useState('');

  // Pet
  const [petType, setPetType] = useState<'dog' | 'cat' | 'other' | ''>('');
  const [petSize, setPetSize] = useState<PetSize>('medium');
  const [petNotes, setPetNotes] = useState('');

  // Current location lookup state
  const [locating, setLocating] = useState(false);

  // Passenger selection
  type RideFor = 'me' | 'someone' | 'vip';
  const [rideFor, setRideFor] = useState<RideFor>('me');
  const [passengerName, setPassengerName] = useState('');
  const [passengerPhone, setPassengerPhone] = useState('');
  const [driverNotes, setDriverNotes] = useState('');
  const [meetGreet, setMeetGreet] = useState(false);
  const [nameSign, setNameSign] = useState(false);

  const carouselRef = useRef<HTMLDivElement>(null);
  const pickupInputRef = useRef<HTMLInputElement>(null);
  const dropoffInputRef = useRef<HTMLInputElement>(null);
  const pickupAcRef = useRef<google.maps.places.Autocomplete | null>(null);
  const dropoffAcRef = useRef<google.maps.places.Autocomplete | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);

  const { route, directionsResult, loading: routeLoading, error: routeError } = useDirections(pickup, dropoff, mapsReady);
  const isPetRide = selectedTier === 'pet_ride';
  const fares: FareResult[] = route ? calculateAllFares(route.distanceKm, route.durationMin, isPetRide && petType ? petSize : undefined) : [];
  const selectedFare = fares.find(f => f.vehicleClass === selectedTier);
  const distanceMiles = route ? kmToMiles(route.distanceKm) : null;
  const hasRoute = !!(pickup && dropoff && route && fares.length > 0);
  const isAirportTrip = (pickup && isAirportAddress(pickup.address)) || (dropoff && isAirportAddress(dropoff.address));

  // ── Map init ───────────────────────────────────────────────────────
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const directionsRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);

  useEffect(() => {
    if (!mapsReady || !mapContainerRef.current) return;
    if (typeof google === 'undefined' || !google.maps?.Map) return;
    if (mapRef.current) return; // already initialized

    mapRef.current = new google.maps.Map(mapContainerRef.current, {
      center: SEATTLE_CENTER,
      zoom: 12,
      disableDefaultUI: true,
      zoomControl: false,
      styles: MAP_STYLES,
      clickableIcons: false,
      // Critical for mobile: 'cooperative' lets single-finger swipes
      // scroll the page through the map instead of panning it. Two
      // fingers (or ctrl+scroll on desktop) are required to interact
      // with the map. Without this, touching the map area during a
      // page scroll halts the scroll — the #1 cause of mobile scroll
      // jank on this page.
      gestureHandling: 'cooperative',
    });

    directionsRendererRef.current = new google.maps.DirectionsRenderer({
      suppressMarkers: true,
      polylineOptions: {
        strokeColor: '#1D1D1F',
        strokeWeight: 5,
        strokeOpacity: 0.85,
      },
    });
    directionsRendererRef.current.setMap(mapRef.current);
  }, [mapsReady]);

  // ── Update route on map ────────────────────────────────────────────
  useEffect(() => {
    if (!directionsRendererRef.current || !mapRef.current) return;

    if (directionsResult) {
      directionsRendererRef.current.setDirections(directionsResult);
      const bounds = directionsResult.routes?.[0]?.bounds;
      if (bounds) mapRef.current.fitBounds(bounds, { top: 50, bottom: 50, left: 40, right: 40 });
    } else {
      directionsRendererRef.current.setDirections({ routes: [] } as unknown as google.maps.DirectionsResult);
      mapRef.current.setCenter(SEATTLE_CENTER);
      mapRef.current.setZoom(12);
    }
  }, [directionsResult]);

  // ── Custom markers ─────────────────────────────────────────────────
  const pickupMarkerRef = useRef<google.maps.Marker | null>(null);
  const dropoffMarkerRef = useRef<google.maps.Marker | null>(null);

  useEffect(() => {
    if (!mapsReady || !mapRef.current || typeof google === 'undefined' || !google.maps?.Marker) return;

    // Pickup marker
    if (pickup) {
      if (pickupMarkerRef.current) {
        pickupMarkerRef.current.setPosition(pickup);
      } else {
        pickupMarkerRef.current = new google.maps.Marker({
          position: pickup,
          map: mapRef.current,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#1D6AE5',
            fillOpacity: 1,
            strokeColor: '#FFFFFF',
            strokeWeight: 3,
          },
          zIndex: 10,
        });
      }
    } else {
      pickupMarkerRef.current?.setMap(null);
      pickupMarkerRef.current = null;
    }

    // Dropoff marker
    if (dropoff) {
      if (dropoffMarkerRef.current) {
        dropoffMarkerRef.current.setPosition(dropoff);
      } else {
        dropoffMarkerRef.current = new google.maps.Marker({
          position: dropoff,
          map: mapRef.current,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#1D1D1F',
            fillOpacity: 1,
            strokeColor: '#FFFFFF',
            strokeWeight: 3,
          },
          zIndex: 10,
        });
      }
    } else {
      dropoffMarkerRef.current?.setMap(null);
      dropoffMarkerRef.current = null;
    }
  }, [pickup, dropoff, mapsReady]);

  // ── Autocomplete ───────────────────────────────────────────────────
  useEffect(() => {
    if (!mapsReady || typeof google === 'undefined' || !google.maps?.places?.Autocomplete) return;
    const bounds = new google.maps.LatLngBounds(
      new google.maps.LatLng(47.4, -122.5),
      new google.maps.LatLng(47.8, -122.1),
    );
    const opts = { fields: ['formatted_address', 'geometry'] as string[], bounds, componentRestrictions: { country: 'us' } };

    if (pickupInputRef.current && !pickupAcRef.current) {
      const ac = new google.maps.places.Autocomplete(pickupInputRef.current, opts);
      ac.addListener('place_changed', () => {
        const p = ac.getPlace();
        if (p.geometry?.location && p.formatted_address) {
          setPickup({ lat: p.geometry.location.lat(), lng: p.geometry.location.lng(), address: p.formatted_address });
          setPickupText(p.formatted_address);
          setBooked(false);
        }
      });
      pickupAcRef.current = ac;
    }
    if (dropoffInputRef.current && !dropoffAcRef.current) {
      const ac = new google.maps.places.Autocomplete(dropoffInputRef.current, opts);
      ac.addListener('place_changed', () => {
        const p = ac.getPlace();
        if (p.geometry?.location && p.formatted_address) {
          setDropoff({ lat: p.geometry.location.lat(), lng: p.geometry.location.lng(), address: p.formatted_address });
          setDropoffText(p.formatted_address);
          setBooked(false);
        }
      });
      dropoffAcRef.current = ac;
    }
  }, [mapsReady]);

  // ── Use current location ───────────────────────────────────────────
  // Triggered by the navigation arrow inside the pickup input.
  // Flow: geolocation permission → reverse geocode via Google Maps → fill pickup.
  const handleUseCurrentLocation = useCallback(() => {
    if (locating) return;
    setBookingError('');

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setBookingError('Location not supported on this device.');
      return;
    }
    if (!mapsReady || typeof google === 'undefined' || !google.maps?.Geocoder) {
      setBookingError('Map still loading. Try again in a moment.');
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        try {
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({ location: { lat, lng } }, (results, status) => {
            if (status === 'OK' && results && results[0]) {
              const address = results[0].formatted_address;
              setPickup({ lat, lng, address });
              setPickupText(address);
              setBooked(false);
            } else {
              // Fall back to raw coords if reverse geocode fails
              const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
              setPickup({ lat, lng, address: fallback });
              setPickupText(fallback);
              setBooked(false);
            }
            setLocating(false);
          });
        } catch {
          setLocating(false);
          setBookingError('Could not resolve address. Enter pickup manually.');
        }
      },
      (err) => {
        setLocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setBookingError('Location permission denied. Enter pickup manually.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setBookingError('Could not determine your location.');
        } else if (err.code === err.TIMEOUT) {
          setBookingError('Location request timed out.');
        } else {
          setBookingError('Could not get your location.');
        }
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [locating, mapsReady]);

  // ── Confirm ride ───────────────────────────────────────────────────
  const confirmRide = useCallback(async () => {
    if (!user) { router.push('/auth/login?redirect=/'); return; }
    if (!pickup || !dropoff || !route || !selectedFare) return;

    setBooking(true);
    setBookingError('');
    try {
      const res = await fetch('/api/bookings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickupAddress: pickup.address, pickupLat: pickup.lat, pickupLng: pickup.lng,
          destinationAddress: dropoff.address, destinationLat: dropoff.lat, destinationLng: dropoff.lng,
          distanceKm: route.distanceKm, durationMin: route.durationMin, vehicleType: selectedTier,
          ...(isAirportTrip && selectedAirline ? { airline: selectedAirline, flightNumber: flightNumber || undefined } : {}),
          ...(isPetRide && petType ? { petType, petSize, petNotes: petNotes || undefined } : {}),
          ...(rideFor !== 'me' ? {
            rideFor,
            passengerName: passengerName || undefined,
            passengerPhone: passengerPhone || undefined,
            ...(rideFor === 'vip' ? { driverNotes: driverNotes || undefined, meetGreet, nameSign } : {}),
          } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { checkoutUrl?: string; error?: string };
      if (!res.ok) {
        if (res.status === 401) { router.push('/auth/login?redirect=/'); return; }
        throw new Error(data.error || 'Booking failed');
      }
      if (data.checkoutUrl) { window.location.href = data.checkoutUrl; return; }
      setBooked(true);
    } catch (err) {
      setBookingError(err instanceof Error ? err.message : 'Could not book ride.');
    } finally {
      setBooking(false);
    }
  }, [
    user, pickup, dropoff, route, selectedFare, selectedTier, router,
    // Optional booking fields read inside the callback — must be deps or the
    // POST body captures their stale initial (empty) values (silent data loss).
    isAirportTrip, selectedAirline, flightNumber,
    isPetRide, petType, petSize, petNotes,
    rideFor, passengerName, passengerPhone, driverNotes, meetGreet, nameSign,
  ]);

  // ── Booked ─────────────────────────────────────────────────────────
  if (booked) {
    return (
      <div className="w-full max-w-full min-w-0 overflow-hidden rounded-3xl border border-[#E5E5EA] bg-white">
        <div className="p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#1D6AE5]/10">
            <svg className="h-8 w-8 text-[#1D6AE5]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <p className="mt-5 text-[20px] font-semibold text-[#1D1D1F]">Ride confirmed</p>
          <p className="mt-2 text-[14px] text-[#86868B] leading-relaxed">{pickup?.address}<br />→ {dropoff?.address}</p>
          <p className="mt-4 text-[28px] font-bold tabular-nums text-[#1D1D1F]">${selectedFare?.total.toFixed(2)}</p>
          <button onClick={() => router.push('/dashboard')} className="mt-6 flex w-full items-center justify-center rounded-2xl bg-[#1D1D1F] py-4 text-[16px] font-semibold text-white hover:bg-[#333]">
            Track your ride
          </button>
        </div>
      </div>
    );
  }

  const ctaLabel = booking ? 'Booking...' : routeLoading ? 'Calculating route...' : !user ? 'Sign in to book' : hasRoute ? `Confirm ride · $${selectedFare?.total.toFixed(2)}` : 'Enter pickup & destination';
  const ctaDisabled = booking || routeLoading || (!!user && !hasRoute);
  const ctaAction = () => { if (!user) router.push('/auth/login?redirect=/'); else if (hasRoute) confirmRide(); };

  return (
    <div className="w-full max-w-full min-w-0 overflow-hidden rounded-3xl border border-[#E5E5EA] bg-white">

      {/* ── Live map ──────────────────────────────────────────────── */}
      <div className="relative h-[240px] bg-[#EEEEF2] overflow-hidden">
        {/* Google Map canvas */}
        <div ref={mapContainerRef} className="absolute inset-0" />

        {/* Loading state when map isn't ready */}
        {!mapsReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#EEEEF2] z-10">
            {mapsFailed ? (
              <p className="text-[13px] text-[#86868B]">Map unavailable</p>
            ) : (
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#D2D2D7] border-t-[#86868B]" />
                <span className="text-[13px] text-[#86868B]">Loading map</span>
              </div>
            )}
          </div>
        )}

        {/* Route info overlay */}
        {hasRoute && (
          <div className="absolute bottom-3 left-3 right-3 z-20 flex items-center justify-between rounded-2xl bg-white/95 px-4 py-3 shadow-[0_2px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-center gap-0.5">
                <div className="h-2 w-2 rounded-full bg-[#1D6AE5]" />
                <div className="h-3 w-[1.5px] bg-[#D2D2D7]" />
                <div className="h-2 w-2 rounded-full bg-[#1D1D1F]" />
              </div>
              <div className="text-[12px] leading-tight">
                <p className="font-medium text-[#1D1D1F] truncate max-w-[140px]">{pickup?.address?.split(',')[0]}</p>
                <p className="font-medium text-[#86868B] truncate max-w-[140px] mt-1">{dropoff?.address?.split(',')[0]}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-right">
              <div>
                <p className="text-[18px] font-bold tabular-nums text-[#1D1D1F]">{distanceMiles}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">mi</p>
              </div>
              <div>
                <p className="text-[18px] font-bold tabular-nums text-[#1D1D1F]">{route!.durationMin}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#86868B]">min</p>
              </div>
            </div>
          </div>
        )}

        {routeLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#D2D2D7] border-t-[#1D1D1F]" />
              <span className="text-[12px] font-medium text-[#1D1D1F]">Calculating route</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Booking form ──────────────────────────────────────────── */}
      <div className="p-5">
        {(bookingError || routeError) && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl bg-[#FF3B30]/8 px-4 py-3">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#FF3B30]" />
            <p className="text-[13px] font-medium text-[#1D1D1F]">{bookingError || routeError}</p>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-xl border border-[#E5E5EA] bg-white pl-4 pr-2 py-3.5 focus-within:border-[#1D1D1F] transition-colors">
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1D6AE5]" />
            <input ref={pickupInputRef} type="text" placeholder="Pickup location" value={pickupText}
              onChange={(e) => { setPickupText(e.target.value); setPickup(null); }}
              className="w-full min-w-0 bg-transparent text-[15px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none" />
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating}
              aria-label="Use current location"
              title="Use current location"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#1D6AE5] transition-colors hover:bg-[#1D6AE5]/10 active:bg-[#1D6AE5]/20 disabled:opacity-40"
            >
              {locating ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#1D6AE5]/30 border-t-[#1D6AE5]" />
              ) : (
                <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 11l19-9-9 19-2-8-8-2z" />
                </svg>
              )}
            </button>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-[#E5E5EA] bg-white px-4 py-3.5 focus-within:border-[#1D1D1F] transition-colors">
            <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#1D1D1F]" />
            <input ref={dropoffInputRef} type="text" placeholder="Where to?" value={dropoffText}
              onChange={(e) => { setDropoffText(e.target.value); setDropoff(null); }}
              className="w-full bg-transparent text-[15px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none" />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="flex items-center gap-2.5 rounded-xl border border-[#E5E5EA] px-4 py-3">
            <svg className="h-4 w-4 text-[#86868B]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
            <span className="text-[14px] font-medium text-[#1D1D1F]">Today</span>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-[#E5E5EA] px-4 py-3">
            <svg className="h-4 w-4 text-[#86868B]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
            <span className="text-[14px] font-medium text-[#1D1D1F]">Now</span>
          </div>
        </div>

        {/* ── Passenger selection ────────────────────────────────── */}
        <div className="mt-3">
          <div className="flex rounded-xl border border-[#E5E5EA] overflow-x-auto md:overflow-hidden scrollbar-none">
            {([
              { id: 'me' as RideFor, label: 'For me' },
              { id: 'someone' as RideFor, label: 'Someone else' },
              { id: 'vip' as RideFor, label: 'VIP guest' },
            ]).map((opt, i) => (
              <button
                key={opt.id}
                onClick={() => setRideFor(opt.id)}
                className={`flex-1 shrink-0 min-w-[33.333%] px-3 py-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
                  i > 0 ? 'border-l border-[#E5E5EA]' : ''
                } ${
                  rideFor === opt.id
                    ? opt.id === 'vip'
                      ? 'bg-[#1D1D1F] text-white'
                      : 'bg-[#1D1D1F] text-white'
                    : 'bg-white text-[#86868B] hover:bg-[#F5F5F7]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Fields for "someone else" */}
          {rideFor === 'someone' && (
            <div className="mt-2 space-y-2">
              <input
                type="text"
                placeholder="Passenger name"
                value={passengerName}
                onChange={(e) => setPassengerName(e.target.value)}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D1D1F] transition-colors"
              />
              <input
                type="tel"
                placeholder="Passenger phone"
                value={passengerPhone}
                onChange={(e) => setPassengerPhone(e.target.value)}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D1D1F] transition-colors"
              />
            </div>
          )}

          {/* Fields for "VIP guest" */}
          {rideFor === 'vip' && (
            <div className="mt-2 space-y-2">
              <input
                type="text"
                placeholder="Guest name"
                value={passengerName}
                onChange={(e) => setPassengerName(e.target.value)}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D1D1F] transition-colors"
              />
              <input
                type="tel"
                placeholder="Guest phone"
                value={passengerPhone}
                onChange={(e) => setPassengerPhone(e.target.value)}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D1D1F] transition-colors"
              />
              <input
                type="text"
                placeholder="Notes for driver (optional)"
                value={driverNotes}
                onChange={(e) => setDriverNotes(e.target.value)}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D1D1F] transition-colors"
              />
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setMeetGreet(!meetGreet)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors ${
                    meetGreet ? 'border-[#1D1D1F] bg-[#1D1D1F] text-white' : 'border-[#E5E5EA] text-[#86868B] hover:border-[#C7C7CC]'
                  }`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                  </svg>
                  Meet & greet
                </button>
                <button
                  type="button"
                  onClick={() => setNameSign(!nameSign)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors ${
                    nameSign ? 'border-[#1D1D1F] bg-[#1D1D1F] text-white' : 'border-[#E5E5EA] text-[#86868B] hover:border-[#C7C7CC]'
                  }`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
                  </svg>
                  Name sign
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Pet details (when pet_ride selected) ──────────────── */}
        {isPetRide && (
          <div className="mt-3 overflow-hidden rounded-xl border border-[#FF9500]/20 bg-[#FF9500]/[0.03]">
            <div className="flex items-center gap-2.5 px-4 py-2.5">
              <span className="text-[14px]">🐾</span>
              <span className="text-[12px] font-semibold text-[#FF9500]">Pet details</span>
            </div>
            <div className="border-t border-[#FF9500]/10 px-4 py-3 space-y-2">
              {/* Pet type */}
              <div className="flex gap-2">
                {([['dog', '🐕'], ['cat', '🐱'], ['other', '🐾']] as const).map(([type, emoji]) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setPetType(type)}
                    className={`flex-1 rounded-lg border py-2 text-center text-[13px] font-medium transition-colors ${
                      petType === type
                        ? 'border-[#FF9500] bg-[#FF9500] text-white'
                        : 'border-[#E5E5EA] text-[#1D1D1F] hover:border-[#C7C7CC]'
                    }`}
                  >
                    {emoji} {type.charAt(0).toUpperCase() + type.slice(1)}
                  </button>
                ))}
              </div>

              {/* Pet size */}
              {petType && (
                <div className="flex gap-2">
                  {(['small', 'medium', 'large'] as const).map(size => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setPetSize(size)}
                      className={`flex-1 rounded-lg border py-2 text-center transition-colors ${
                        petSize === size
                          ? 'border-[#1D1D1F] bg-[#1D1D1F] text-white'
                          : 'border-[#E5E5EA] text-[#86868B] hover:border-[#C7C7CC]'
                      }`}
                    >
                      <p className="text-[12px] font-semibold">{size.charAt(0).toUpperCase() + size.slice(1)}</p>
                      <p className={`text-[10px] ${petSize === size ? 'text-white/60' : 'text-[#A1A1A6]'}`}>+${PET_FEES[size]}</p>
                    </button>
                  ))}
                </div>
              )}

              {/* Pet notes */}
              {petType && (
                <input
                  type="text"
                  placeholder="Notes (e.g. calm dog, carrier included)"
                  value={petNotes}
                  onChange={(e) => setPetNotes(e.target.value)}
                  maxLength={200}
                  className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[13px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#FF9500] transition-colors"
                />
              )}
            </div>
          </div>
        )}

        {/* ── Airport trip: airline info ────────────────────────── */}
        {isAirportTrip && (
          <div className="mt-3 overflow-hidden rounded-xl border border-[#1D6AE5]/20 bg-[#1D6AE5]/[0.03]">
            <div className="flex items-center gap-2.5 px-4 py-2.5">
              <svg className="h-4 w-4 text-[#1D6AE5]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
              </svg>
              <span className="text-[12px] font-semibold text-[#1D6AE5]">Airport ride</span>
            </div>
            <div className="border-t border-[#1D6AE5]/10 px-4 py-3 space-y-2">
              <div className="relative">
                <select
                  value={selectedAirline}
                  onChange={(e) => setSelectedAirline(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 pr-8 text-[14px] font-medium text-[#1D1D1F] outline-none focus:border-[#1D6AE5] transition-colors"
                >
                  <option value="">Select airline</option>
                  {AIRLINES.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#86868B]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Flight number (optional)"
                value={flightNumber}
                onChange={(e) => setFlightNumber(e.target.value.toUpperCase())}
                maxLength={10}
                className="w-full rounded-lg border border-[#E5E5EA] bg-white px-3.5 py-2.5 text-[14px] font-medium text-[#1D1D1F] placeholder-[#C7C7CC] outline-none focus:border-[#1D6AE5] transition-colors"
              />
            </div>
          </div>
        )}

        {/* ── Vehicle selector ────────────────────────────────── */}
        <div className="mt-5">
          {/* Header + arrows */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#A1A1A6]">Select ride</p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => carouselRef.current?.scrollBy({ left: -190, behavior: 'smooth' })}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-[#E5E5EA] bg-white text-[#86868B] transition-colors hover:border-[#C7C7CC] hover:text-[#1D1D1F]"
                aria-label="Previous"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
              </button>
              <button
                onClick={() => carouselRef.current?.scrollBy({ left: 190, behavior: 'smooth' })}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-[#E5E5EA] bg-white text-[#86868B] transition-colors hover:border-[#C7C7CC] hover:text-[#1D1D1F]"
                aria-label="Next"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
              </button>
            </div>
          </div>

          {/* Cards */}
          <div className="-mx-5">
            <div ref={carouselRef} className="flex gap-2 overflow-x-auto pl-5 pr-8 md:pr-5 pb-2 scrollbar-none scroll-smooth">
              {SEATTLE_TIERS.map(tier => {
                const active = selectedTier === tier.id;
                const fare = fares.find(f => f.vehicleClass === tier.id);
                const isWomen = tier.id === 'women_rider';
                const isPetTier = tier.id === 'pet_ride';

                const ICONS: Record<string, { icon: string; color: string }> = {
                  electric:          { icon: 'm3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z', color: '#1D6AE5' },
                  comfort_electric:  { icon: 'M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z', color: '#1D6AE5' },
                  premium_electric:  { icon: 'M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z', color: '#FF9F0A' },
                  suv_electric:      { icon: 'M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12', color: '#1D1D1F' },
                  women_rider:       { icon: 'M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z', color: '#AF52DE' },
                };

                return (
                  <button key={tier.id} onClick={() => setSelectedTier(tier.id)}
                    className={`shrink-0 w-[82px] rounded-2xl border px-1.5 py-3.5 text-center transition-all duration-200 ${
                      active
                        ? isWomen ? 'border-[#AF52DE] bg-[#AF52DE] text-white shadow-[0_2px_12px_rgba(175,82,222,0.2)]'
                        : isPetTier ? 'border-[#FF9500] bg-[#FF9500] text-white shadow-[0_2px_12px_rgba(255,149,0,0.2)]'
                        : 'border-[#1D1D1F] bg-[#1D1D1F] text-white shadow-[0_2px_12px_rgba(0,0,0,0.1)]'
                        : 'border-[#E5E5EA] bg-white text-[#1D1D1F] hover:border-[#C7C7CC] hover:shadow-[0_1px_4px_rgba(0,0,0,0.04)]'
                    }`}>
                    <div className="mx-auto flex h-7 w-7 items-center justify-center">
                      {isPetTier ? (
                        <span className="text-[16px]">🐾</span>
                      ) : ICONS[tier.id] ? (
                        <svg className="h-[18px] w-[18px]" style={{ color: active ? 'white' : ICONS[tier.id].color }} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d={ICONS[tier.id].icon} />
                        </svg>
                      ) : null}
                    </div>
                    <p className={`mt-1.5 text-[10px] font-semibold leading-tight ${active ? 'text-white' : 'text-[#1D1D1F]'}`}>{tier.name}</p>
                    <p className={`mt-1 text-[12px] tabular-nums font-bold ${active ? 'text-white/80' : 'text-[#1D1D1F]'}`}>{fare ? `$${fare.total.toFixed(2)}` : '—'}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dots */}
          <div className="mt-2.5 flex justify-center gap-1">
            {SEATTLE_TIERS.map(tier => (
              <div key={tier.id} className={`h-[3px] rounded-full transition-all duration-300 ${selectedTier === tier.id ? 'w-5 bg-[#1D1D1F]' : 'w-[3px] bg-[#D2D2D7]'}`} />
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-[#F5F5F7] px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">Estimated fare</p>
            <p className="mt-1 text-[26px] font-bold tabular-nums tracking-tight text-[#1D1D1F]">
              {routeLoading ? <span className="inline-block h-6 w-20 animate-pulse rounded bg-[#E5E5EA]" /> : selectedFare ? `$${selectedFare.total.toFixed(2)}` : '—'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">Distance</p>
            <p className="mt-1 text-[18px] font-bold tabular-nums text-[#1D1D1F]">{distanceMiles ? `${distanceMiles} mi` : '—'}</p>
          </div>
        </div>

        <button onClick={ctaAction} disabled={!!ctaDisabled}
          className={`mt-4 flex w-full items-center justify-center rounded-2xl py-4 text-[16px] font-semibold transition-all duration-200 ${ctaDisabled ? 'bg-[#E5E5EA] text-[#A1A1A6]' : 'bg-[#1D1D1F] text-white hover:bg-[#333] active:scale-[0.98]'}`}>
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}
