import { describe, expect, it } from 'vitest';
import {
  composeAirportSnapshot,
  instructionDirectionFor,
  normalizePlaceName,
  selectAirportFee,
  servicePointTypeAllowed,
  type AirportServicePointType,
  type SnapshotParts,
  type TripAirportDirection,
} from '../airports/logic';

// ── Direction ↔ point-type matrix ────────────────────────────────────────

describe('servicePointTypeAllowed', () => {
  const cases: Array<[TripAirportDirection, AirportServicePointType, boolean]> = [
    // Drop-off may only land on departures curbs.
    ['airport_dropoff', 'general_departures_dropoff', true],
    ['airport_dropoff', 'airline_departures_dropoff', true],
    ['airport_dropoff', 'rideshare_pickup', false],
    ['airport_dropoff', 'arrivals_reference', false],
    // Pickup may only land on the rideshare zone.
    ['airport_pickup', 'rideshare_pickup', true],
    ['airport_pickup', 'general_departures_dropoff', false],
    ['airport_pickup', 'airline_departures_dropoff', false],
    // arrivals_reference is context, never bookable in either direction.
    ['airport_pickup', 'arrivals_reference', false],
  ];

  it.each(cases)('%s + %s → %s', (direction, pointType, expected) => {
    expect(servicePointTypeAllowed(direction, pointType)).toBe(expected);
  });
});

describe('instructionDirectionFor', () => {
  it('maps trip directions to instruction directions', () => {
    expect(instructionDirectionFor('airport_pickup')).toBe('pickup');
    expect(instructionDirectionFor('airport_dropoff')).toBe('dropoff');
  });
});

// ── Controlled name normalization ────────────────────────────────────────

describe('normalizePlaceName', () => {
  it('lowercases, collapses punctuation runs, and trims', () => {
    expect(normalizePlaceName('Seattle–Tacoma  Int\'l  Airport ')).toBe('seattle tacoma int l airport');
    expect(normalizePlaceName('SEA-TAC')).toBe('sea tac');
    expect(normalizePlaceName('   ')).toBe('');
  });
});

// ── Fee selection ────────────────────────────────────────────────────────

describe('selectAirportFee', () => {
  const today = '2026-07-19';

  it('returns null with no rules', () => {
    expect(selectAirportFee([], 'airport_dropoff', today)).toBeNull();
  });

  it('applies a both-direction fee to either direction', () => {
    const rules = [
      { config: { amount: 5, currency: 'usd', direction: 'both' }, effective_from: null, effective_to: null },
    ];
    expect(selectAirportFee(rules, 'airport_dropoff', today)).toEqual({ amount: 5, currency: 'USD', direction: 'both' });
    expect(selectAirportFee(rules, 'airport_pickup', today)).toEqual({ amount: 5, currency: 'USD', direction: 'both' });
  });

  it('honors direction-specific fees', () => {
    const rules = [
      { config: { amount: 3, currency: 'USD', direction: 'pickup' }, effective_from: null, effective_to: null },
    ];
    expect(selectAirportFee(rules, 'airport_pickup', today)?.amount).toBe(3);
    expect(selectAirportFee(rules, 'airport_dropoff', today)).toBeNull();
  });

  it('respects effective date windows', () => {
    const rules = [
      { config: { amount: 4, currency: 'USD', direction: 'both' }, effective_from: '2026-08-01', effective_to: null },
      { config: { amount: 2, currency: 'USD', direction: 'both' }, effective_from: null, effective_to: '2026-01-01' },
    ];
    expect(selectAirportFee(rules, 'airport_dropoff', today)).toBeNull();
    expect(selectAirportFee(rules, 'airport_dropoff', '2026-08-15')?.amount).toBe(4);
  });

  it('skips malformed configs instead of charging NaN', () => {
    const rules = [
      { config: { amount: 'lots', currency: 'USD', direction: 'both' }, effective_from: null, effective_to: null },
      { config: null, effective_from: null, effective_to: null },
      { config: { amount: -2, currency: 'USD', direction: 'both' }, effective_from: null, effective_to: null },
      { config: { amount: 6, currency: 'USD', direction: 'both' }, effective_from: null, effective_to: null },
    ];
    expect(selectAirportFee(rules, 'airport_dropoff', today)?.amount).toBe(6);
  });
});

// ── Snapshot shaping ─────────────────────────────────────────────────────

function baseParts(): SnapshotParts {
  return {
    airport: { id: 'a1', iata_code: 'SEA', display_name: 'Seattle-Tacoma International', updated_at: '2026-07-01T00:00:00Z' },
    direction: 'airport_dropoff',
    airline: { id: 'al1', display_name: 'Alaska Airlines', iata_code: 'AS', updated_at: '2026-07-10T00:00:00Z' },
    terminal: { id: 't1', code: 'M', name: 'Main Terminal', updated_at: '2026-07-05T00:00:00Z' },
    servicePoint: {
      id: 'sp1',
      point_type: 'airline_departures_dropoff',
      name: 'Departures Drive — Door 5',
      lat: 47.4431,
      lng: -122.3007,
      level: 'Upper',
      door: '5',
      zone: null,
      island: null,
      updated_at: '2026-07-15T00:00:00Z',
    },
    riderInstructions: [{ title: 'Curb', body: 'Use the upper drive.', updated_at: '2026-07-12T00:00:00Z' }],
    driverInstructions: [{ title: 'Stay in vehicle', body: 'Active loading only.', image_url: 'https://x/y.png' }],
    fee: { amount: 5, currency: 'USD' },
    flightNumber: 'AS 123',
    selectionMethod: 'airline',
    extraVersions: ['2026-07-18T00:00:00Z'],
  };
}

describe('composeAirportSnapshot', () => {
  it('shapes the full snapshot with every section', () => {
    const snap = composeAirportSnapshot(baseParts());
    expect(snap.airport).toEqual({ id: 'a1', iata_code: 'SEA', display_name: 'Seattle-Tacoma International' });
    expect(snap.direction).toBe('airport_dropoff');
    expect(snap.airline).toEqual({ id: 'al1', display_name: 'Alaska Airlines', iata_code: 'AS' });
    expect(snap.terminal).toEqual({ id: 't1', code: 'M', name: 'Main Terminal' });
    expect(snap.service_point).toEqual({
      id: 'sp1',
      point_type: 'airline_departures_dropoff',
      name: 'Departures Drive — Door 5',
      lat: 47.4431,
      lng: -122.3007,
      level: 'Upper',
      door: '5',
      zone: null,
      island: null,
    });
    expect(snap.instructions.rider).toEqual([{ title: 'Curb', body: 'Use the upper drive.' }]);
    expect(snap.instructions.driver).toEqual([
      { title: 'Stay in vehicle', body: 'Active loading only.', image_url: 'https://x/y.png' },
    ]);
    expect(snap.fee).toEqual({ amount: 5, currency: 'USD' });
    expect(snap.flight_number).toBe('AS 123');
    expect(snap.selection_method).toBe('airline');
  });

  it('config_version is the max updated_at across all involved rows', () => {
    const snap = composeAirportSnapshot(baseParts());
    expect(snap.config_version).toBe('2026-07-18T00:00:00.000Z');
  });

  it('omits optional sections when absent', () => {
    const parts = baseParts();
    parts.airline = null;
    parts.terminal = null;
    parts.fee = null;
    parts.flightNumber = null;
    const snap = composeAirportSnapshot(parts);
    expect(snap.airline).toBeUndefined();
    expect(snap.terminal).toBeUndefined();
    expect(snap.fee).toBeUndefined();
    expect(snap.flight_number).toBeUndefined();
    // Instruction updated_at bookkeeping never leaks into the stored snapshot.
    expect(Object.keys(snap.instructions.rider[0])).toEqual(['title', 'body']);
  });
});
