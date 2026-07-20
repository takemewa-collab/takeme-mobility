/**
 * Decodes a base64 string into raw bytes. Hermes ships a global `atob`, so no
 * dependency is needed — this exists because Supabase's uploadToSignedUrl
 * wants an ArrayBuffer/TypedArray, while expo-image-picker hands back base64.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
