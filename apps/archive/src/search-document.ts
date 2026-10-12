import { Bool, Field, Float64, List, Schema, Utf8 } from 'apache-arrow';
import { ArchiveError } from '@character-unity/archive-client/contract';

// Application projection from Archive b99dcd1 search-index.js and
// search/LanceSearchBackend.js. This is not a card-format parser.
const strings = ['id', 'name', 'tagline', 'description', 'platform_summary', 'author', 'source', 'sourceId', 'sourcePath', 'sourceSpecific', 'fullPath', 'type', 'language', 'visibility', 'created', 'createdAt', 'added', 'updated', 'lastModified', 'searchText'];
export const searchBooleans = ['hasAlternateGreetings', 'hasLorebook', 'hasEmbeddedLorebook', 'hasLinkedLorebook', 'hasExampleDialogues', 'hasSystemPrompt', 'hasGallery', 'hasEmbeddedImages', 'hasExpressions'];
const directNumbers = ['tokenCount', 'rating', 'ratingCount', 'starCount', 'n_favorites', 'nChats', 'nMessages', 'tokenDescriptionCount', 'tokenPersonalityCount', 'tokenScenarioCount', 'tokenMesExampleCount', 'tokenFirstMessageCount', 'tokenSystemPromptCount', 'tokenPostHistoryCount'];
const numbers = ['favorited', ...directNumbers, 'token_count', 'favorites', 'scoreComposite', 'scoreVelocity', 'engagementScore', 'engagementVelocity'];
const directStrings = ['name', 'tagline', 'description', 'author', 'source', 'sourceId', 'sourcePath', 'fullPath', 'language', 'visibility', 'createdAt', 'lastModified', 'topics'];
export const searchSourceColumns = ['id', ...directStrings, 'favorited', ...searchBooleans, ...directNumbers];
export const searchDocumentSchema = new Schema([
  ...strings.map((name) => new Field(name, new Utf8(), false)),
  ...['tags', 'topics'].map((name) => new Field(name, new List(new Field('item', new Utf8(), false)), false)),
  ...searchBooleans.map((name) => new Field(name, new Bool(), false)),
  ...numbers.map((name) => new Field(name, new Float64(), false)),
]);
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
export function scoringDate(value: string) {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid('Scoring date must be an explicit UTC timestamp, for example 2026-10-12T00:00:00.000Z');
  return date.getTime();
}
export function buildSearchDocument(row: Record<string, unknown>, asOf: number) {
  if (!Number.isFinite(asOf)) invalid('Invalid scoring date');
  for (const name of searchSourceColumns) if (!Object.hasOwn(row, name)) invalid(`Copied database lacks search column ${name}`);
  function text(name: string) {
    const value = row[name];
    if (value === null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') invalid(`Invalid search string ${name}`);
    return String(value);
  }
  function number(name: string) {
    const value = row[name];
    if (value !== null && !['string', 'number', 'bigint'].includes(typeof value)) invalid(`Invalid search number ${name}`);
    const result = Number(value);
    if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) invalid(`Search number ${name} must be finite and within the safe-number range`);
    return result;
  }
  const doc: Record<string, string | number | boolean | string[]> = {};
  for (const name of directStrings) doc[name] = text(name);
  doc.id = text('id'); doc.source ||= 'chub'; doc.sourceId ||= doc.id;
  doc.fullPath ||= doc.sourcePath!; doc.language ||= 'unknown'; doc.visibility ||= 'unknown';
  doc.platform_summary = doc.description!; doc.sourceSpecific = doc.sourcePath!; doc.type = 'character';
  doc.created = doc.added = doc.createdAt!; doc.updated = doc.lastModified!;
  doc.tags = doc.topics = text('topics').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  for (const name of searchBooleans) doc[name] = Boolean(row[name]);
  doc.favorited = row.favorited ? 1 : 0;
  for (const name of directNumbers) doc[name] = number(name);
  doc.token_count = doc.tokenCount!; doc.favorites = doc.n_favorites!;
  function age(date: string, fallback: number) {
    if (!date) return fallback;
    // Legacy SQLite dates without a zone used the host timezone. A generation
    // always uses UTC for them, so two operators produce the same row values.
    const normalized = date.replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(normalized)) invalid('Search dates must be ISO dates or SQLite UTC timestamps');
    const day = new Date(`${normalized.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== normalized.slice(0, 10)) invalid('Invalid search calendar date');
    const withTime = normalized.includes('T') ? normalized : `${normalized}T00:00:00`;
    const timestamp = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(withTime) ? withTime : `${withTime}Z`);
    if (!Number.isFinite(timestamp)) invalid('Invalid search date');
    return Math.max(1, (asOf - timestamp) / 86_400_000);
  }
  const createdAge = age(text('createdAt'), 1), activityAge = age(text('lastModified') || text('createdAt'), createdAge);
  const composite = number('starCount') + number('n_favorites') * 2;
  const bonus = activityAge <= 3 ? 25 : activityAge <= 7 ? 15 : activityAge <= 14 ? 8 : 0;
  const engagement = number('nChats') * 1.5 + number('nMessages') * 0.1 + number('n_favorites') * 2 + number('starCount') * 0.5
    + Math.max(0, number('rating') - 3) * number('ratingCount') * 0.2 + bonus;
  doc.scoreComposite = composite; doc.scoreVelocity = composite / createdAge;
  doc.engagementScore = engagement; doc.engagementVelocity = engagement / activityAge;
  for (const name of numbers) if (!Number.isFinite(doc[name])) invalid('Derived search score is not finite');
  doc.searchText = [doc.name, doc.tagline, doc.description, doc.platform_summary, doc.author, doc.tags.join(' '), doc.source, doc.sourcePath, doc.fullPath].filter(Boolean).join('\n');
  return doc;
}
