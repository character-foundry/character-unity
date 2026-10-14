import { useEffect, useId, useState } from 'react';
import type { EditorDocument, JsonValue } from './model';
import { useCardStore, type CardStore } from '../../store/card-store';
import { useEditorSession } from '../context';
import { LorebookLibraryImport } from './library-import';
import './lorebook.css';
import { LLMAssistSidebar } from '../../features/editor/components/LLMAssistSidebar';
type LorebookDraft = Pick<CardStore, 'editLorebook'>;
import { bookFields, characterBook, editableBook, editableLoreField, entryFields, entryLabel, loreObject, loreValue } from './model';
import type { LoreField } from './model';
import { LorebookFiles } from './files-view';

function NumberInput({ id, value, field, change }: { id: string; value: JsonValue | undefined; field: LoreField; change(value: JsonValue | undefined): void }) {
  const display = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(display);
  useEffect(() => setText(display), [display]);
  function valid(raw: string) {
    const number = Number(raw);
    return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(number)
      && (field.fractional || Number.isSafeInteger(number)) && Math.abs(number) <= Number.MAX_SAFE_INTEGER
      && number >= (field.min ?? Number.MIN_SAFE_INTEGER) && number <= (field.max ?? Number.MAX_SAFE_INTEGER);
  }
  // Keep partial input such as '-' locally until it becomes a valid number.
  // Invalid text never changes the card; leaving the control restores its value.
  const invalid = text !== '' && !valid(text);
  return <><input id={id} inputMode={field.fractional ? 'decimal' : 'numeric'} value={text} aria-invalid={invalid || undefined}
    aria-describedby={`${id}-number-help`} onBlur={() => setText(display)} onChange={(event) => {
      const raw = event.target.value; setText(raw);
      if (raw === '' && !field.required) change(undefined);
      else if (valid(raw)) change(Number(raw));
    }} />
    <p className="editor-help" id={`${id}-number-help`}>{invalid ? 'Invalid number. The last valid value is kept.'
      : `${field.fractional ? 'Number' : 'Whole number'}${field.min !== undefined ? `, minimum ${field.min}` : ''}${field.max !== undefined ? `, maximum ${field.max}` : ''}.`}</p></>;
}

function LoreInput({ target, field, change }: {
  target: EditorDocument; field: LoreField; change(value: JsonValue | undefined): void;
}) {
  const id = useId();
  const value = loreValue(target, field);
  if (!editableLoreField(target, field)) return <p className="editor-help">{field.label} has a value this form cannot edit. It will be preserved when saving.</p>;
  const note = value === null ? 'Currently null; changing this control sets an explicit value.' : undefined;
  if (field.kind === 'keys') {
    const keys = (value ?? []) as string[];
    return <fieldset className="editor-field">
      <legend>{field.label}</legend>
      {note && <p className="editor-help">{note}</p>}
      {keys.map((key, index) => <div className="editor-array-item" key={index}>
        <label htmlFor={`${id}-${index}`}>{field.label} {index + 1}</label>
        <input id={`${id}-${index}`} value={key} onChange={(event) => change(keys.map((old, i) => i === index ? event.target.value : old))} />
        <button type="button" onClick={() => change(keys.filter((_, i) => i !== index))}>Remove {field.label.toLowerCase()} {index + 1}</button>
      </div>)}
      <button type="button" onClick={() => change([...keys, ''])}>Add {field.label.toLowerCase()}</button>
      <p className="editor-help">One key per field. Commas and spaces within a key are preserved.</p>
    </fieldset>;
  }
  return <div className="editor-field">
    <label htmlFor={id}>{field.label}</label>
    {field.kind === 'boolean' || field.kind === 'choice'
      ? <select id={id} value={value === undefined ? 'absent' : JSON.stringify(value)} onChange={(event) => change(event.target.value === 'absent' ? undefined : JSON.parse(event.target.value))}>
        <option value="absent" disabled={field.required && value !== undefined}>Not set</option>
        {field.nullable && <option value="null">None (null)</option>}
        {field.kind === 'boolean' ? <><option value="true">Yes</option><option value="false">No</option></>
          : field.choices!.map((choice) => <option key={choice} value={JSON.stringify(choice)}>{choice || 'Default (empty)'}</option>)}
      </select>
      : field.kind === 'textarea'
        ? <textarea id={id} rows={field.path === 'content' ? 8 : 3} value={String(value ?? '')} onChange={(event) => change(event.target.value)} />
        : field.kind === 'number' ? <NumberInput id={id} value={value} field={field} change={change} />
          : <input id={id} value={String(value ?? '')} onChange={(event) => change(event.target.value)} />}
    {note && <p className="editor-help">{note}</p>}
  </div>;
}

export function NativeLorebookEditor() {
  const session = useEditorSession();
  const state = useCardStore();
  const [generation, setGeneration] = useState(0);
  const attached = () => setGeneration((value) => value + 1);
  if (!state.currentCard) return null;
  return <div className="native-lorebook"><LorebookFiles attached={attached} />
    <LorebookLibraryImport attached={attached} />
    <LorebookFields key={generation} editor={session.cards.getState()} document={state.currentCard.data as unknown as EditorDocument} saving={state.isSaving || state.isRestoring} /></div>;
}

function LorebookFields({ editor, document, saving }: { editor: LorebookDraft; document: EditorDocument; saving: boolean }) {
  const session = useEditorSession();
  const [selected, select] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [deletion, setDeletion] = useState<{ index: number; entry: JsonValue } | null>(null);
  const [assist, setAssist] = useState<{ index: number | null; field: 'description' | 'content' | 'keys'; target: EditorDocument } | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const id = useId();
  const book = characterBook(document);
  if (book === undefined || book === null) return <div>
    <p>This card does not have a lorebook.</p>
    <button type="button" disabled={saving} onClick={() => { editor.editLorebook({ type: 'initialize' }); select(null); setQuery(''); }}>Create lorebook</button>
  </div>;
  if (!editableBook(book)) return <p className="editor-help">This lorebook has an unsupported shape. It will be preserved when saving other fields.</p>;
  const entries = (book.entries ?? []) as JsonValue[];
  const selection = selected !== null && selected < entries.length ? selected : null;
  const entry = selection === null ? undefined : entries[selection];
  const search = query.toLocaleLowerCase();
  const visible = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => {
    const text = [entryLabel(entry, index), ...(loreObject(entry) ? [entry.content, entry.comment,
      ...(Array.isArray(entry.keys) ? entry.keys : []), ...(Array.isArray(entry.secondary_keys) ? entry.secondary_keys : [])] : [])];
    return text.some((part) => typeof part === 'string' && part.toLocaleLowerCase().includes(search));
  });
  return <div className="editor-lorebook">
    <details className="editor-lore-settings">
      <summary>Lorebook settings</summary>
      <fieldset disabled={saving} className="editor-field">
        <legend className="editor-visually-hidden">Lorebook settings</legend>
        {bookFields.map((field) => <LoreInput key={field.path} target={book} field={field}
          change={(value) => editor.editLorebook({ type: 'book-field', field: field.path, value })} />)}
        {session.capabilities.browserLLM && typeof book.description === 'string' && <button type="button" onClick={() => { setAssistError(null); setAssist({ index: null, field: 'description', target: book }); }}>Assist lorebook description</button>}
      </fieldset>
    </details>
    <div className="editor-inline">
      <button type="button" disabled={saving} onClick={() => { editor.editLorebook({ type: 'add' }); select(entries.length); setQuery(''); setDeletion(null); }}>Add entry</button>
      <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
    </div>
    <div className="editor-field editor-lore-filter">
      <label htmlFor={`${id}-filter`}>Find lorebook entries</label>
      <input id={`${id}-filter`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, keys or content" />
    </div>
    <div className="editor-lore-list" role="group" aria-label="Lorebook entries">
      {visible.map(({ entry, index }) => <button type="button" key={index} aria-pressed={selection === index}
        aria-controls={`${id}-entry`} onClick={() => { select(index); setDeletion(null); }}>
        <span>{index + 1}. {entryLabel(entry, index)}</span>
        {loreObject(entry) && entry.enabled === false && <small>Disabled</small>}
      </button>)}
      {visible.length === 0 && <p className="editor-help">{entries.length ? 'No matching entries.' : 'Add an entry to begin.'}</p>}
    </div>
    <section id={`${id}-entry`} aria-label="Selected lorebook entry">
      {selection === null ? <p className="editor-help">Select an entry to edit.</p> : <>
        <div className="editor-inline editor-lore-actions">
          <button type="button" disabled={saving || !loreObject(entry)} onClick={() => { editor.editLorebook({ type: 'copy', index: selection }); select(entries.length); setQuery(''); setDeletion(null); }}>Copy entry</button>
          <button type="button" disabled={saving || selection === 0} onClick={() => { editor.editLorebook({ type: 'move', index: selection, offset: -1 }); select(selection - 1); setDeletion(null); }}>Move earlier</button>
          <button type="button" disabled={saving || selection === entries.length - 1} onClick={() => { editor.editLorebook({ type: 'move', index: selection, offset: 1 }); select(selection + 1); setDeletion(null); }}>Move later</button>
          <button type="button" disabled={saving} onClick={() => setDeletion({ index: selection, entry: entry! })}>Delete entry</button>
          {session.capabilities.browserLLM && loreObject(entry) && <>
            <button type="button" disabled={saving || typeof entry.content !== 'string'} onClick={() => { setAssistError(null); setAssist({ index: selection, field: 'content', target: entry }); }}>Assist entry content</button>
            <button type="button" disabled={saving || !Array.isArray(entry.keys) || !entry.keys.every((key) => typeof key === 'string')} onClick={() => { setAssistError(null); setAssist({ index: selection, field: 'keys', target: entry }); }}>Assist primary keys (JSON)</button>
          </>}
        </div>
        <p className="editor-help">Moving changes list order. Each entry keeps its insertion order.</p>
        {deletion && deletion.index === selection && deletion.entry === entry && <div className="editor-confirm">
          <p>Delete {entryLabel(entry!, selection)} from this draft? Discard changes restores the saved lorebook.</p>
          <button type="button" disabled={saving} onClick={() => { editor.editLorebook({ type: 'remove', index: selection }); select(null); setDeletion(null); }}>Confirm delete entry</button>
          <button type="button" onClick={() => setDeletion(null)}>Keep entry</button>
        </div>}
        {loreObject(entry) ? <fieldset disabled={saving} className="editor-field editor-lore-fields">
          <legend className="editor-visually-hidden">Entry fields</legend>
          {entryFields.filter((field) => !field.v3 || document.spec === 'chara_card_v3').map((field) => <LoreInput key={`${selection}-${field.path}`} target={entry} field={field}
            change={(value) => editor.editLorebook({ type: 'entry-field', index: selection, field: field.path, value })} />)}
        </fieldset> : <p className="editor-help">This entry has an unsupported shape. It will be preserved unless you explicitly delete it.</p>}
      </>}
    </section>
    {assistError && <p role="alert" className="editor-error">{assistError}</p>}
    {assist && <LLMAssistSidebar isOpen onClose={() => setAssist(null)} fieldName={`lorebook_${assist.field}`}
      currentValue={assist.field === 'keys' ? JSON.stringify(assist.target.keys) : String(assist.target[assist.field] ?? '')}
      cardSpec={document.spec === 'chara_card_v3' ? 'v3' : 'v2'} onApply={(value, action) => {
        try {
          const target = assist.index === null ? book : entries[assist.index];
          if (saving || target !== assist.target || (assist.index !== null && selected !== assist.index)) throw new Error('The lorebook draft changed. Review the current field before running assistance again.');
          let next: JsonValue = value;
          if (assist.field === 'keys') {
            const parsed: unknown = JSON.parse(value);
            if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === 'string')) throw new Error('Primary keys must be a JSON array of strings. No keys were changed.');
            next = action === 'append' ? [...assist.target.keys as string[], ...parsed] : parsed;
          } else if (action === 'append') next = `${String(assist.target[assist.field] ?? '')}\n${value}`;
          if (assist.index === null) editor.editLorebook({ type: 'book-field', field: assist.field, value: next });
          else editor.editLorebook({ type: 'entry-field', index: assist.index, field: assist.field, value: next });
          setAssist(null); setAssistError(null);
        } catch (failure) { setAssistError(failure instanceof Error ? failure.message : 'Lorebook assistance could not be applied'); }
      }} />}
  </div>;
}
