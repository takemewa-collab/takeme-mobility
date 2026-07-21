import { describe, expect, it } from 'vitest';
import { formatE164Display, maskPhone, toE164 } from '../phone-format';

describe('formatE164Display', () => {
  it('formats NANP numbers the way Americans read them', () => {
    expect(formatE164Display('+14155550111')).toBe('+1 (415) 555-0111');
    expect(formatE164Display('+12065550134')).toBe('+1 (206) 555-0134');
  });

  it('prefers the longest matching dial code', () => {
    // +52 must match Mexico, not fall through some "+5" heuristic.
    expect(formatE164Display('+525512345678')).toBe('+52 551 234 567 8');
    expect(formatE164Display('+905321234567')).toBe('+90 532 123 456 7');
  });

  it('never renders garbage for unparseable input', () => {
    expect(formatE164Display('')).toBe('');
    expect(formatE164Display('not-a-number')).toBe('not-a-number');
    expect(formatE164Display('+1')).toBe('+1');
  });

  it('round-trips what toE164 produces', () => {
    expect(formatE164Display(toE164('1', '4155550111'))).toBe('+1 (415) 555-0111');
  });
});

describe('maskPhone', () => {
  it('reveals only the last four digits', () => {
    const masked = maskPhone('+14155550111', '1');
    expect(masked).toContain('0111');
    expect(masked).not.toContain('415');
  });
});
