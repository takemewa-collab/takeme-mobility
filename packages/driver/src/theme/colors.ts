/**
 * Takeme Driver colour palette — pure monochrome, matching the rider app and
 * the design architecture: no hue, precision through greyscale and weight.
 * Status is carried by fill and tone, not colour. A light surface keeps text
 * maximally readable in daylight, where drivers work.
 */
export const colors = {
  // Brand — near-black, no accent hue
  primary: '#111111',
  primaryLight: '#1C1C1E',
  accent: '#111111',
  accentLight: '#3A3A3C',
  accentDark: '#000000',

  // Semantic — monochrome tones; meaning comes from label + placement
  success: '#111111',
  warning: '#6B6B6B',
  error: '#111111',
  info: '#6B6B6B',

  // Neutrals — true (hueless) greys
  white: '#FFFFFF',
  black: '#000000',
  gray50: '#FAFAFA',
  gray100: '#F5F5F5',
  gray200: '#ECECEC',
  gray300: '#D8D8D8',
  gray400: '#B0B0B0',
  gray500: '#8A8A8A',
  gray600: '#6B6B6B',
  gray700: '#4A4A4A',
  gray800: '#2C2C2E',
  gray900: '#111111',

  // Backgrounds
  background: '#FFFFFF',
  backgroundSecondary: '#FAFAFA',
  card: '#FFFFFF',
  overlay: 'rgba(0, 0, 0, 0.5)',

  // Text
  text: '#111111',
  textSecondary: '#6B6B6B',
  textInverse: '#FFFFFF',
  textMuted: '#8A8A8A',

  // Borders
  border: '#ECECEC',
  borderFocused: '#111111',

  // Activation status — the ONLY hued tokens in the app. Reserved for status
  // text, badges, and dots; never buttons or chrome. Status is always paired
  // with a text label, never conveyed by colour alone.
  statusApproved: '#137A3F',
  statusWarning: '#8A5A00',
  statusCritical: '#B3261E',

  // Driver status — distinguished by tone (filled black = live, grey = idle)
  online: '#111111',
  offline: '#B0B0B0',
  busy: '#4A4A4A',
  onTrip: '#111111',
} as const;
