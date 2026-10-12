/** Width and height from a PNG header, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Sources sometimes serve a placeholder or blurred stand-in for a portrait (Chub's 240×240 "fuzz" image).
 * Such an image must not replace a real portrait the Archive already holds.
 */
export function isPlaceholderImage(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2_048) return true;
  const size = pngSize(bytes);
  if (!size) return false;
  return Math.min(size.width, size.height) <= 32 || (size.width === 240 && size.height === 240 && bytes.byteLength < 150_000);
}
