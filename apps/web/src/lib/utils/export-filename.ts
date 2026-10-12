export interface CardExportNamingInput {
  name?: string | null;
  creator?: string | null;
  slug?: string | null;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Windows disallowed filename chars + control chars
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
}

function getSlugSuffix(slug: string): string {
  const parts = slug.split('-').filter(Boolean);
  if (parts.length === 0) return '';
  return parts[parts.length - 1] || '';
}

/**
 * Build an export/download filename for a card.
 *
 * Template:
 * - With creator: [[creatorname]]_[[charname]]_[[whatever]].ext
 * - Without creator: [[charname]]_[[whatever]].ext
 *
 * `[[whatever]]` uses the unique suffix from the card slug.
 */
export function buildCardExportFilename(input: CardExportNamingInput, ext: string): string {
  const extension = (ext || 'bin').replace(/^\./, '').toLowerCase();

  const creatorRaw = (input.creator || '').trim();
  const nameRaw = (input.name || '').trim();
  const slugRaw = (input.slug || '').trim();

  const creator = creatorRaw ? sanitizeFilenamePart(creatorRaw) : '';
  const charName = sanitizeFilenamePart(nameRaw || slugRaw || 'card');
  const whatever = sanitizeFilenamePart(slugRaw ? getSlugSuffix(slugRaw) : '');

  const parts = [creator, charName, whatever].filter(Boolean);
  const base = parts.join('_') || 'card';

  // Keep filenames reasonably short across platforms
  const maxBaseLen = 180;
  const safeBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen).replace(/[._]+$/g, '') : base;

  return `${safeBase}.${extension}`;
}

