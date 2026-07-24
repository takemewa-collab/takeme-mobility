import { describe, expect, it } from 'vitest';
import {
  instantFeeUsd,
  netPayoutUsd,
  parseAmountInput,
  validateCashOutAmount,
} from '../payout-math';

const FEES = { instantFeePct: 0.015, instantFeeMinUsd: 0.5, standardFeeUsd: 0 };

describe('instantFeeUsd — display preview of the server fee policy', () => {
  it('applies the minimum fee to small amounts', () => {
    // 1.5% of $10 = $0.15 < $0.50 minimum
    expect(instantFeeUsd(10, 0.015, 0.5)).toBe(0.5);
  });

  it('applies the percentage fee above the minimum threshold', () => {
    expect(instantFeeUsd(100, 0.015, 0.5)).toBe(1.5);
  });

  it('rounds to cents', () => {
    // 1.5% of $77.77 = 1.16655 → $1.17
    expect(instantFeeUsd(77.77, 0.015, 0.5)).toBe(1.17);
  });

  it('is zero for non-positive or invalid amounts', () => {
    expect(instantFeeUsd(0, 0.015, 0.5)).toBe(0);
    expect(instantFeeUsd(-5, 0.015, 0.5)).toBe(0);
    expect(instantFeeUsd(Number.NaN, 0.015, 0.5)).toBe(0);
  });
});

describe('netPayoutUsd', () => {
  it('subtracts the instant fee', () => {
    expect(netPayoutUsd(100, 'instant', FEES)).toBe(98.5);
  });

  it('standard payouts are free under the current fee schedule', () => {
    expect(netPayoutUsd(100, 'standard', FEES)).toBe(100);
  });

  it('never goes negative', () => {
    expect(netPayoutUsd(0.25, 'instant', FEES)).toBe(0);
  });
});

describe('parseAmountInput', () => {
  it('accepts plain dollars and cents', () => {
    expect(parseAmountInput('25')).toBe(25);
    expect(parseAmountInput('25.5')).toBe(25.5);
    expect(parseAmountInput('25.50')).toBe(25.5);
  });

  it('tolerates a leading dollar sign and whitespace', () => {
    expect(parseAmountInput(' $12.34 ')).toBe(12.34);
  });

  it('rejects malformed, negative, zero, and >2-decimal input', () => {
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('-5')).toBeNull();
    expect(parseAmountInput('0')).toBeNull();
    expect(parseAmountInput('1.999')).toBeNull();
    expect(parseAmountInput('1.2.3')).toBeNull();
  });
});

describe('validateCashOutAmount', () => {
  it('flags amounts over the available balance', () => {
    expect(validateCashOutAmount(50.01, 50, 1)).toBe('exceeds_available');
  });

  it('flags amounts under the minimum payout', () => {
    expect(validateCashOutAmount(0.5, 50, 1)).toBe('below_minimum');
  });

  it('flags unparseable amounts', () => {
    expect(validateCashOutAmount(null, 50, 1)).toBe('invalid');
  });

  it('passes a full-balance cash out', () => {
    expect(validateCashOutAmount(50, 50, 1)).toBeNull();
  });
});
