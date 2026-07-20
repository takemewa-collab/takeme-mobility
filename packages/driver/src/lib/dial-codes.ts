/**
 * Country dial codes offered on the phone-entry screen. Name and code only —
 * no flag emoji, matching the monochrome design language. The United States
 * is the default market and sits first.
 */
export type DialCode = {
  /** Display name shown in the picker. Unique — used as the list key. */
  name: string;
  /** Dial code digits, without the leading plus. */
  dial: string;
  /** Plausible national-number length bounds, used to gate Continue. */
  minDigits: number;
  maxDigits: number;
};

const UNITED_STATES: DialCode = {
  name: 'United States',
  dial: '1',
  minDigits: 10,
  maxDigits: 10,
};

export const DIAL_CODES: DialCode[] = [
  UNITED_STATES,
  { name: 'Canada', dial: '1', minDigits: 10, maxDigits: 10 },
  { name: 'Mexico', dial: '52', minDigits: 10, maxDigits: 10 },
  { name: 'United Kingdom', dial: '44', minDigits: 9, maxDigits: 10 },
  { name: 'Germany', dial: '49', minDigits: 7, maxDigits: 11 },
  { name: 'France', dial: '33', minDigits: 9, maxDigits: 9 },
  { name: 'Spain', dial: '34', minDigits: 9, maxDigits: 9 },
  { name: 'Italy', dial: '39', minDigits: 8, maxDigits: 11 },
  { name: 'Netherlands', dial: '31', minDigits: 9, maxDigits: 9 },
  { name: 'Turkey', dial: '90', minDigits: 10, maxDigits: 10 },
  { name: 'Australia', dial: '61', minDigits: 9, maxDigits: 9 },
  { name: 'Japan', dial: '81', minDigits: 9, maxDigits: 11 },
  { name: 'South Korea', dial: '82', minDigits: 8, maxDigits: 11 },
  { name: 'Brazil', dial: '55', minDigits: 10, maxDigits: 11 },
  { name: 'India', dial: '91', minDigits: 10, maxDigits: 10 },
];

export const DEFAULT_DIAL_CODE = UNITED_STATES;
