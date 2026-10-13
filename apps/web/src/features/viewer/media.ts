/** Content may render bound revision bytes and inline raster data, never unsolicited external URLs. */
export function safeImageSource(source: string, resources: Record<string, string>): string | null {
  if (Object.hasOwn(resources, source)) return resources[source];
  return /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(source) ? source : null;
}
