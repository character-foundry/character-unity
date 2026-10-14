export interface TokenPort {
  readonly label: string;
  readonly local?: boolean;
  count(texts: readonly string[], signal: AbortSignal): Promise<readonly number[]>;
}
export const tokenLimits = { texts: 2000, characters: 1_000_000 } as const;
export function validateTokenTexts(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > tokenLimits.texts || value.some((text) => typeof text !== 'string')
    || value.reduce((sum, text: string) => sum + text.length, 0) > tokenLimits.characters) {
    throw new Error('Card text is too large or has an unsupported shape for token counting.');
  }
}
