import type { JsonValue } from '@character-unity/store';
import { contentByteLimit } from '@character-unity/store/content';
import { ContentError } from './errors.js';

/** Compare decimal spellings, not binary floating-point approximations. Equivalent
 * forms such as 1e3/1000 and 0.70/0.7 are allowed; precision-rounded values are not. */
function decimal(token: string) {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parts) throw new ContentError('INVALID_INPUT','JSON contains an unsupported numeric token');
  const fraction = parts[3] ?? '', digits = `${parts[2]}${fraction}`.replace(/^0+/,'');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/,''), exponent = Number(parts[4] ?? 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(exponent)) throw new ContentError('INVALID_INPUT','JSON number exponent cannot be preserved');
  return `${parts[1]}${significant}e${exponent}`;
}
/** Uses the platform parser's original primitive source (JSON.parse reviver
 * context.source), so numbers are checked before a rounded value can be saved or
 * deduplicated. No custom JSON parser or silently lossy fallback is used. */
export function parseContentJson(text: string): JsonValue {
  if (typeof text !== 'string') throw new ContentError('INVALID_INPUT','Provide the complete raw JSON text');
  if (new TextEncoder().encode(text).byteLength > contentByteLimit) throw new ContentError('TOO_LARGE','Standalone JSON is limited to 1 MiB');
  try {
    return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text,(_key: string,value: unknown,context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!context || typeof context.source !== 'string') throw new ContentError('UNAVAILABLE','This runtime cannot safely validate authored JSON numbers; use a current browser or Node 24 host');
      if (!Number.isFinite(value) || Object.is(value,-0) || (Number.isInteger(value) && !Number.isSafeInteger(value))
        || decimal(context.source) !== decimal(JSON.stringify(value))) {
        throw new ContentError('INVALID_INPUT','JSON contains a number that cannot be preserved without rounding; encode that value as a string before importing or saving');
      }
      return value;
    }) as JsonValue;
  } catch (error) {
    if (error instanceof ContentError) throw error;
    throw new ContentError('INVALID_INPUT','Choose valid JSON; the complete source has not been changed');
  }
}
