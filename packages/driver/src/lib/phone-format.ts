/**
 * Display formatting for the auth flow. These helpers are presentation-only —
 * the wire format is always E.164 built from the raw digits.
 */

/**
 * North American numbers read as (206) 555-0134 while the driver types.
 * Everywhere else, digits group in threes — scannable without pretending to
 * know every national convention.
 */
export function formatNationalNumber(digits: string, dial: string): string {
  if (dial === '1') return formatNanp(digits);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function formatNanp(digits: string): string {
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

/** Longest formatted string a number of `maxDigits` can render as. */
export function formattedMaxLength(dial: string, maxDigits: number): number {
  if (dial === '1') return 14; // "(206) 555-0134"
  return maxDigits + Math.floor((maxDigits - 1) / 3);
}

/** Builds the E.164 string Clerk expects. */
export function toE164(dial: string, digits: string): string {
  return `+${dial}${digits}`;
}

/**
 * "+12065550134" with dial "1" → "+1 ••• ••• 0134". Never reveals more than
 * the last four digits — the verify screen must not display (or log) the full
 * number.
 */
export function maskPhone(e164: string, dial?: string): string {
  const digits = e164.replace(/\D/g, '');
  const prefix = dial && digits.startsWith(dial) ? dial : '';
  const national = prefix ? digits.slice(prefix.length) : digits;
  const visible = national.slice(-4);
  let hidden = Math.max(national.length - visible.length, 0);
  const groups: string[] = [];
  while (hidden > 0) {
    const size = Math.min(3, hidden);
    groups.push('•'.repeat(size));
    hidden -= size;
  }
  return [prefix ? `+${prefix}` : null, ...groups, visible]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}
