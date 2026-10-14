import { tokenLimits, validateTokenTexts } from '@character-unity/tokenizer';
import type { Card } from '../lib/types';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalarFields = [
  ['name', 'Name'], ['description', 'Description'], ['personality', 'Personality'], ['scenario', 'Scenario'],
  ['first_mes', 'First Message'], ['mes_example', 'Example Dialogue'], ['system_prompt', 'System Prompt'],
  ['post_history_instructions', 'Post History Instructions'], ['creator_notes', 'Creator Notes'],
] as const;

/** Count selected text, never coerced metadata or a reconstructed chat prompt.
 * Wrapper detection is structural: one opaque field must not hide other text. */
export function projectTokenText(card: Card) {
  const envelope: unknown = card.data;
  const data = record(envelope) && record(envelope.data) ? envelope.data : {};
  const payload: Record<string, string> = {}, fields: { key: string; label: string; parts: string[] }[] = [], omitted: string[] = [];
  let disabledLoreEntries = 0, textCount = 0;
  function add(key: string, label: string, values: unknown[], array = false) {
    const parts: string[] = [];
    values.forEach((value, index) => {
      if (value === undefined || value === null) return;
      if (typeof value !== 'string') { omitted.push(label); return; }
      const part = array ? `${key}_${index}` : key; payload[part] = value; parts.push(part);
      if (++textCount > tokenLimits.texts) throw new Error('Too many text fields for token counting.');
    });
    fields.push({ key, label, parts });
  }
  for (const [key, label] of scalarFields) add(key, label, [data[key]]);
  const extensions = record(data.extensions) ? data.extensions : {};
  const voxta = record(extensions.voxta) ? extensions.voxta : {};
  add('appearance', 'Appearance', [extensions.visual_description ?? voxta.appearance]);
  const depth = record(extensions.depth_prompt) ? extensions.depth_prompt : {};
  add('character_note', 'Character Note', [depth.prompt]);
  for (const [key, part, label] of [['alternate_greetings', 'alternate_greeting', 'Alternate Greetings'],
    ['group_only_greetings', 'group_only_greeting', 'Group Only Greetings']] as const) {
    const value = data[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) omitted.push(label);
    const values = Array.isArray(value) ? value : [];
    if (values.length > tokenLimits.texts) throw new Error('Too many greetings for token counting.');
    add(part, label, values, true);
    fields[fields.length - 1]!.key = key;
  }
  const book = data.character_book, contents: unknown[] = [];
  if (book !== undefined && book !== null) {
    if (!record(book) || (book.entries !== undefined && !Array.isArray(book.entries))) omitted.push('Enabled lorebook entries');
    else if (Array.isArray(book.entries)) {
      if (book.entries.length > tokenLimits.texts) throw new Error('Too many lorebook entries for token counting.');
      for (const entry of book.entries) {
        if (!record(entry)) { omitted.push('Enabled lorebook entries'); continue; }
        if (entry.enabled === false) { disabledLoreEntries++; continue; }
        if (entry.enabled !== undefined && entry.enabled !== true) { omitted.push('Enabled lorebook entries'); continue; }
        contents.push(entry.content);
      }
    }
  }
  add('lorebook_entry', 'Enabled lorebook entries', contents, true); fields[fields.length - 1]!.key = 'lorebook';
  validateTokenTexts(Object.values(payload));
  return { payload, fields, omitted: [...new Set(omitted)], disabledLoreEntries };
}
