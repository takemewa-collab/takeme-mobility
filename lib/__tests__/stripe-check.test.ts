import { describe, expect, it } from 'vitest';
import { runStripeCheck, stripeCheckModeFor } from '../monitoring/stripe-check';

// Dummy keys for tests only — never real credentials.
const LIVE_KEY = 'sk_live_dummy_key_for_tests_000000';
const TEST_KEY = 'sk_test_dummy_key_for_tests_000000';

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
}

function fetchRecorder(responses: Array<Record<string, unknown>> = []) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const payload = responses[Math.min(i++, responses.length - 1)] ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('stripeCheckModeFor', () => {
  it('is read-only for live keys', () => {
    expect(stripeCheckModeFor(LIVE_KEY)).toBe('live_readonly');
  });
  it('is synthetic only for explicit test keys', () => {
    expect(stripeCheckModeFor(TEST_KEY)).toBe('test_synthetic');
  });
  it('fails safe to read-only for restricted or unknown key shapes', () => {
    expect(stripeCheckModeFor('rk_live_abc')).toBe('live_readonly');
    expect(stripeCheckModeFor('sk_something_else')).toBe('live_readonly');
  });
});

describe('runStripeCheck with a live key', () => {
  it('performs exactly one read-only GET /v1/balance and touches nothing else', async () => {
    const { fetchFn, calls } = fetchRecorder();
    const result = await runStripeCheck(LIVE_KEY, fetchFn);
    expect(result.mode).toBe('live_readonly');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/balance');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].body).toBeUndefined();
  });

  it('never creates, cancels, captures, confirms, or refunds anything', async () => {
    const { fetchFn, calls } = fetchRecorder();
    await runStripeCheck(LIVE_KEY, fetchFn);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url).not.toContain('/payment_intents');
      expect(call.url).not.toContain('/refunds');
      expect(call.url).not.toContain('/charges');
    }
  });

  it('throws when the read-only check fails', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as typeof fetch;
    await expect(runStripeCheck(LIVE_KEY, fetchFn)).rejects.toThrow(/401/);
  });
});

describe('runStripeCheck with a test key', () => {
  it('runs the synthetic $1 create-and-cancel cycle', async () => {
    const { fetchFn, calls } = fetchRecorder([{ id: 'pi_synthetic_1' }]);
    const result = await runStripeCheck(TEST_KEY, fetchFn);
    expect(result.mode).toBe('test_synthetic');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain('amount=100');
    expect(calls[0].body).toContain('metadata[test]=e2e_monitor');
    expect(calls[1].url).toBe('https://api.stripe.com/v1/payment_intents/pi_synthetic_1/cancel');
    expect(calls[1].method).toBe('POST');
  });
});

describe('runStripeCheck without a key', () => {
  it('throws', async () => {
    const { fetchFn } = fetchRecorder();
    await expect(runStripeCheck('', fetchFn)).rejects.toThrow(/not set/);
  });
});
