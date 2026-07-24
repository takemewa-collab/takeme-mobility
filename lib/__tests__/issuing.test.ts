import { describe, expect, it } from 'vitest';
import { cashbackRateFor, computeCashback, issuingAmountDollars } from '../issuing';

const RATES = { ev: 3, gas: 2, other: 1 };

describe('cashbackRateFor', () => {
  it('gives the EV rate for EV charging categories, including fuel_electric', () => {
    expect(cashbackRateFor('electric_vehicle_charging', RATES)).toBe(0.03);
    expect(cashbackRateFor('fuel_electric', RATES)).toBe(0.03); // contains "fuel" too — EV must win
  });

  it('gives the gas rate for fuel/gas categories', () => {
    expect(cashbackRateFor('fuel_dispenser_automated', RATES)).toBe(0.02);
    expect(cashbackRateFor('gas_station', RATES)).toBe(0.02);
  });

  it('falls back to the other rate', () => {
    expect(cashbackRateFor('grocery_stores', RATES)).toBe(0.01);
    expect(cashbackRateFor('', RATES)).toBe(0.01);
    expect(cashbackRateFor(null, RATES)).toBe(0.01);
  });
});

describe('computeCashback', () => {
  it('rounds to cents', () => {
    expect(computeCashback(33.33, 'grocery_stores', RATES)).toBe(0.33);
    expect(computeCashback(10, 'electric_vehicle_charging', RATES)).toBe(0.3);
  });

  it('is zero for zero/negative/invalid amounts', () => {
    expect(computeCashback(0, 'gas', RATES)).toBe(0);
    expect(computeCashback(-5, 'gas', RATES)).toBe(0);
    expect(computeCashback(NaN, 'gas', RATES)).toBe(0);
  });
});

describe('issuingAmountDollars', () => {
  it('converts signed integer cents to positive dollars', () => {
    expect(issuingAmountDollars(-1234)).toBe(12.34);
    expect(issuingAmountDollars(1234)).toBe(12.34);
  });

  it('is zero for missing values', () => {
    expect(issuingAmountDollars(null)).toBe(0);
    expect(issuingAmountDollars(undefined)).toBe(0);
  });
});
