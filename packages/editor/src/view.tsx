import { useId, useState, useSyncExternalStore } from 'react';
import { editableField, fieldValue } from './controller.js';
import type { EditorController, JsonValue } from './controller.js';
import { fieldDefinitions, tabDefinitions } from './fields.js';
import type { FieldDefinition, TabId } from './fields.js';
import { LorebookEditor } from './lorebook-view.js';
import { AssetEditor } from './assets-view.js';
import { RevisionHistory } from './history-view.js';
import { TokenCounts } from './tokens-view.js';

const sections = [...tabDefinitions, { id: 'lorebook', label: 'Lorebook' }, { id: 'history', label: 'History' }, { id: 'assets', label: 'Assets' }, { id: 'tokens', label: 'Tokens' }] as const;

function Field({ field, value, change, disabled }: {
  field: FieldDefinition; value: JsonValue | undefined; change(value: JsonValue): void; disabled: boolean;
}) {
  const id = useId();
  const [language, setLanguage] = useState('');
  const help = field.helpText ? `${id}-help` : undefined;
  if (field.type === 'array' || field.type === 'tags') {
    const values = (value ?? []) as string[];
    return <fieldset className="editor-field" disabled={disabled} aria-describedby={help}>
      <legend>{field.label}</legend>
      {values.map((item, index) => <div className="editor-array-item" key={index}>
        <label htmlFor={`${id}-${index}`}>{field.itemLabel ?? 'Tag'} {index + 1}</label>
        {field.rows
          ? <textarea id={`${id}-${index}`} rows={Math.min(field.rows, 5)} value={item} onChange={(event) => change(values.map((old, i) => i === index ? event.target.value : old))} />
          : <input id={`${id}-${index}`} value={item} onChange={(event) => change(values.map((old, i) => i === index ? event.target.value : old))} />}
        <button type="button" onClick={() => change(values.filter((_, i) => i !== index))}>Remove {field.itemLabel ?? 'Tag'} {index + 1}</button>
      </div>)}
      <button type="button" onClick={() => change([...values, ''])}>{field.addButtonText ?? 'Add Tag'}</button>
      {field.helpText && <p id={help} className="editor-help">{field.helpText}</p>}
    </fieldset>;
  }
  if (field.type === 'map') {
    const values = (value ?? {}) as Record<string, string>;
    return <fieldset className="editor-field" disabled={disabled} aria-describedby={help}>
      <legend>{field.label}</legend>
      {Object.entries(values).map(([key, item], index) => <div className="editor-array-item" key={key}>
        <label htmlFor={`${id}-${index}`}>Notes ({key})</label>
        <textarea id={`${id}-${index}`} rows={3} value={item} onChange={(event) => change({ ...values, [key]: event.target.value })} />
        <button type="button" onClick={() => change(Object.fromEntries(Object.entries(values).filter(([k]) => k !== key)))}>Remove {key}</button>
      </div>)}
      <label htmlFor={`${id}-language`}>Language code</label>
      <div className="editor-inline"><input id={`${id}-language`} placeholder="en" value={language} onChange={(event) => setLanguage(event.target.value)} />
        <button type="button" disabled={!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || Object.hasOwn(values, language)} onClick={() => { change({ ...values, [language]: '' }); setLanguage(''); }}>Add Language</button></div>
      {field.helpText && <p id={help} className="editor-help">{field.helpText}</p>}
    </fieldset>;
  }
  return <div className="editor-field">
    <label htmlFor={id}>{field.label}</label>
    {field.rows ? <textarea id={id} rows={Math.min(field.rows, 8)} value={String(value ?? '')} disabled={disabled}
      placeholder={field.placeholder} maxLength={field.maxLength} aria-describedby={help} onChange={(event) => change(event.target.value)} />
      : <input id={id} type={field.type === 'number' ? 'number' : 'text'} value={value === undefined ? '' : String(value)} disabled={disabled}
        placeholder={field.placeholder ?? (field.defaultValue === undefined ? undefined : String(field.defaultValue))}
        min={field.min} max={field.max} maxLength={field.maxLength} aria-describedby={help}
        onChange={(event) => {
          if (field.type !== 'number') change(event.target.value);
          else if (event.target.value !== '' && event.target.validity.valid) change(Number(event.target.value));
        }} />}
    {field.helpText && <p id={help} className="editor-help">{field.helpText}</p>}
  </div>;
}

/** Mount any number of controllers. The host decides when to create or replace them. */
export function CardEditor({ editor }: { editor: EditorController }) {
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const [tab, setTab] = useState<TabId | 'lorebook' | 'history' | 'assets' | 'tokens'>('basic');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const id = useId();
  const spec = state.document.spec === 'chara_card_v3' ? 'v3' : 'v2';
  const saving = state.status === 'saving';
  return <div className="card-editor">
    <div className="editor-toolbar">
      <span role="status">{saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : state.status === 'saved' ? 'Saved' : 'No changes'}</span>
      <button type="button" disabled={saving || !state.dirty} onClick={() => { setConfirmDiscard(false); void editor.save(); }}>Save revision</button>
      <button type="button" disabled={saving || !state.dirty} onClick={() => setConfirmDiscard(true)}>Discard changes</button>
    </div>
    {confirmDiscard && state.dirty && <div className="editor-confirm">
      <p>Discard the unsaved changes in this editor?</p>
      <button type="button" disabled={saving} onClick={() => { editor.discard(); setConfirmDiscard(false); }}>Confirm discard</button>
      <button type="button" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
    </div>}
    {state.error && <p role="alert" className="editor-error">{state.error}</p>}
    <div className="editor-tabs" role="group" aria-label="Editor sections">
      {sections.filter((item) => (item.id !== 'history' || editor.history) && (item.id !== 'assets' || editor.assets) && (item.id !== 'tokens' || editor.tokens)).map((item) => <button type="button" key={item.id} aria-pressed={tab === item.id}
        aria-controls={`${id}-fields`} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <section id={`${id}-fields`} aria-label={`${sections.find((item) => item.id === tab)!.label} fields`}>
      {tab === 'lorebook' ? <LorebookEditor editor={editor} document={state.document} saving={saving} />
        : tab === 'assets' ? editor.assets && <AssetEditor key={state.revisionId} editor={editor} state={state} />
        : tab === 'history' ? editor.history && <RevisionHistory port={editor.history} draft={state} />
        : tab === 'tokens' ? editor.tokens && <TokenCounts port={editor.tokens} document={state.document} />
        : fieldDefinitions.filter((field) => field.tab === tab && field.specs.includes(spec) && field.type !== 'readonly').map((field) =>
        editableField(state.document, field)
          ? <Field key={field.id} field={field} value={fieldValue(state.document, field)} change={(value) => editor.edit(field.id, value)} disabled={saving} />
          : <p key={field.id} className="editor-help">{field.label} has a value this form cannot edit. It will be preserved when saving.</p>)}
    </section>
  </div>;
}
