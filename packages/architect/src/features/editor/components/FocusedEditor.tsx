import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCardStore, extractCardData } from '../../../store/card-store';
import { useEditorSession } from '../../../unity/context';
import { useSettingsStore } from '../../../store/settings-store';
import {
  normalizeSpec,
  type CCv2Data,
  type CCv3Data,
  type Template,
  type Snippet,
  type CCFieldName,
  type FocusField,
} from '../../../lib/types';
import { getFieldById } from '../config/field-definitions';
import { readFieldValue, writeFieldValue, type FieldValue } from './field-value';
import { PreservedField } from './FieldRenderer';
import { MilkdownProvider } from '@milkdown/react';
import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
import { editorViewCtx, parserCtx } from '@milkdown/kit/core';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { Slice } from '@milkdown/kit/prose/model';
import { Selection } from '@milkdown/kit/prose/state';
import { eclipse } from '@uiw/codemirror-theme-eclipse';
import throttle from 'lodash.throttle';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as codemirrorMarkdown } from '@codemirror/lang-markdown';
import { html as codemirrorHtml } from '@codemirror/lang-html';
import { githubDark } from '@uiw/codemirror-theme-github';
import { EditorView } from '@codemirror/view';
import { TemplateSnippetPanel } from './TemplateSnippetPanel';
import { LLMAssistSidebar } from './LLMAssistSidebar';
import { AuthoredHtml, unavailableImage, useAuthoredImageUrls } from '../../../unity/authored-media';

// Field definitions with settings keys for extended fields
type LocalFocusField =
  | 'description'
  | 'scenario'
  | 'personality'
  | 'appearance'
  | 'character_note'
  | 'first_mes'
  | 'alternate_greetings'
  | 'mes_example'
  | 'system_prompt'
  | 'post_history_instructions'
  | 'creator_notes';

interface FieldDef {
  id: LocalFocusField;
  label: string;
  tag?: string;
  settingKey?:
    | 'personality'
    | 'appearance'
    | 'characterNote'
    | 'exampleDialogue'
    | 'systemPrompt'
    | 'postHistory';
  alwaysShow?: boolean;
}

// All possible fields in the new order
const ALL_FIELDS: FieldDef[] = [
  { id: 'description', label: 'Description', alwaysShow: true },
  { id: 'scenario', label: 'Scenario', alwaysShow: true },
  { id: 'personality', label: 'Personality', settingKey: 'personality' },
  { id: 'appearance', label: 'Appearance', tag: 'VOX', settingKey: 'appearance' },
  { id: 'character_note', label: 'Character Note', tag: 'Ext', settingKey: 'characterNote' },
  { id: 'first_mes', label: 'Greetings', alwaysShow: true },
  { id: 'mes_example', label: 'Example Dialogue', settingKey: 'exampleDialogue' },
  { id: 'system_prompt', label: 'System Prompt', settingKey: 'systemPrompt' },
  { id: 'post_history_instructions', label: 'Post History', settingKey: 'postHistory' },
  { id: 'creator_notes', label: 'Creator Notes', alwaysShow: true },
];

interface CrepeEditorProps {
  value: string;
  editorKey: number;
  imageKey: string;
  imageUrl: (source: string) => string;
  onChange: (markdown: string) => void;
  onReady: (instance: Crepe | null) => void;
}

// Programmatic update function from playground - preserves cursor position
function updateCrepeContent(crepe: Crepe, markdown: string) {
  if (crepe.getMarkdown() === markdown) return;

  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    const doc = parser(markdown);
    if (!doc) return;

    const state = view.state;
    const selection = state.selection;
    const { from } = selection;

    let tr = state.tr;
    tr = tr.replace(0, state.doc.content.size, new Slice(doc.content, 0, 0));

    const docSize = doc.content.size;
    const safeFrom = Math.min(from, docSize - 2);
    tr = tr.setSelection(Selection.near(tr.doc.resolve(safeFrom)));
    view.dispatch(tr);
  });
}

function CrepeMarkdownEditor({ value, editorKey, imageKey, imageUrl, onChange, onReady }: CrepeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value), callbacks = useRef({ onChange, onReady, imageUrl });
  valueRef.current = value;
  callbacks.current = { onChange, onReady, imageUrl };

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let ready = false;
    // Pending creation owns its own mount, so late teardown cannot remove a replacement editor.
    const mount = document.createElement('div');
    containerRef.current.replaceChildren(mount);
    const changed = throttle((markdown: string) => { if (!disposed) callbacks.current.onChange(markdown); }, 200);

    // Crepe configuration with proper features enabled - playground pattern
    const crepe = new Crepe({
      root: mount,
      defaultValue: valueRef.current || '',
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          // Must be synchronous: Milkdown mounts the authored src before an
          // asynchronous proxy resolves. The document's URI is never rewritten.
          proxyDomURL: (source) => callbacks.current.imageUrl(source),
        },
        [Crepe.Feature.CodeMirror]: {
          theme: eclipse, // Light theme for code blocks (can switch based on dark mode later)
        },
        [Crepe.Feature.Placeholder]: {
          text: 'Type your markdown here...',
        },
      },
    });

    // Use listener plugin approach with throttling (playground pattern)
    crepe.editor
      .config((ctx) => {
        // CommonMark supplies null for an untitled image, while the installed
        // block schema requires a string caption. Normalize the display parse
        // only; source URIs and the authored document stay untouched.
        ctx.update(imageBlockSchema.key, (previous) => (schemaContext) => {
          const schema = previous(schemaContext), parse = schema.parseMarkdown;
          return { ...schema, parseMarkdown: { ...parse, runner(state, node, type) {
            parse.runner(state, { ...node, title: typeof node.title === 'string' ? node.title : '' }, type);
          } } };
        });
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => { changed(markdown); });
      })
      .use(listener);

    crepe
      .create()
      .then(() => {
        if (disposed) { void crepe.destroy().catch((error: unknown) => { console.error('Error destroying discarded Crepe editor:', error); }); return; }
        ready = true;
        callbacks.current.onReady(crepe);
      })
      .catch((error) => {
        if (!disposed) console.error('Failed to create Crepe editor:', error);
      });

    return () => {
      if (ready) { valueRef.current = crepe.getMarkdown(); changed.flush(); }
      disposed = true;
      changed.cancel();
      if (ready) void crepe.destroy().catch((error: unknown) => { console.error('Error destroying Crepe editor:', error); });
      mount.remove();
      callbacks.current.onReady(null);
    };
  }, [editorKey, imageKey]);

  return <div ref={containerRef} className="h-full w-full" />;
}

type FocusType = 'wysiwyg' | 'raw' | null;

function FocusedEditorInner() {
  const session = useEditorSession();
  const { currentCard, updateCardData } = useCardStore();
  const { creatorNotes, editor } = useSettingsStore();
  const [selectedField, setSelectedField] = useState<LocalFocusField>('description');
  const [drafts, setDrafts] = useState<Record<LocalFocusField, string>>({
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    alternate_greetings: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    creator_notes: '',
    appearance: '',
    character_note: '',
  });
  const [alternateGreetingIndex, setAlternateGreetingIndex] = useState(-1); // -1 = First Message, 0+ = alt greeting index
  const [editorKey, setEditorKey] = useState(0);
  const [showRawPanel, setShowRawPanel] = useState(false);
  const [editorFocus, setEditorFocus] = useState<FocusType>(null);
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [llmAssistOpen, setLLMAssistOpen] = useState(false);
  const crepeRef = useRef<Crepe | null>(null);
  const rawMarkdownRef = useRef<string>('');
  const prevFieldRef = useRef<LocalFocusField | null>(null);

  const isV3 = currentCard?.meta.spec === 'v3';
  const cardData = useMemo(() => {
    if (!currentCard) return null;
    return extractCardData(currentCard);
  }, [currentCard]);

  // Build the list of focusable fields based on settings
  const focusableFields = useMemo(() => {
    return ALL_FIELDS.filter((field) => {
      // Always show fields without settingKey
      if (field.alwaysShow) return true;
      // Check settings for extended fields
      if (field.settingKey) {
        return editor.extendedFocusedFields[field.settingKey];
      }
      return true;
    });
  }, [editor.extendedFocusedFields]);

  const readFocusField = useCallback((field: LocalFocusField): FieldValue => {
    if (!cardData) return { value: undefined, editable: false };
    const isAlternate = field === 'alternate_greetings' || (field === 'first_mes' && alternateGreetingIndex >= 0);
    const definition = getFieldById(isAlternate ? 'alternate_greetings' : field)!;
    const state = readFieldValue(definition, cardData as unknown as Record<string, unknown>);
    if (!isAlternate || !state.editable) return state;
    return { value: (state.value as string[] | undefined)?.[Math.max(0, alternateGreetingIndex)], editable: true };
  }, [cardData, alternateGreetingIndex]);
  const getFieldValue = useCallback((field: LocalFocusField): string => {
    const state = readFocusField(field);
    return state.editable && typeof state.value === 'string' ? state.value : '';
  }, [readFocusField]);

  useEffect(() => {
    if (!currentCard) return;
    const next: Record<LocalFocusField, string> = {
      description: getFieldValue('description'),
      personality: getFieldValue('personality'),
      scenario: getFieldValue('scenario'),
      first_mes: getFieldValue('first_mes'),
      alternate_greetings: getFieldValue('alternate_greetings'),
      mes_example: getFieldValue('mes_example'),
      system_prompt: getFieldValue('system_prompt'),
      post_history_instructions: getFieldValue('post_history_instructions'),
      creator_notes: getFieldValue('creator_notes'),
      appearance: getFieldValue('appearance'),
      character_note: getFieldValue('character_note'),
    };
    setDrafts(next);
    setSelectedField((prev) => prev ?? 'description');
    // Only recreate editor when card changes, not on field changes
    setEditorKey((key) => key + 1);
  }, [currentCard?.meta.id, currentCard?.meta.spec, getFieldValue]);

  // Use programmatic update when switching fields instead of destroying editor
  useEffect(() => {
    // Update editor when field or alternate greeting index changes
    const shouldUpdate =
      prevFieldRef.current !== selectedField || (selectedField as string) === 'alternate_greetings';

    if (!shouldUpdate && selectedField !== 'alternate_greetings') {
      return;
    }
    prevFieldRef.current = selectedField;

    // Get value from drafts, fallback to card data if not in drafts yet
    const draftValue = drafts[selectedField];
    const cardValue = getFieldValue(selectedField);
    const value = draftValue !== undefined ? draftValue : cardValue;

    if (crepeRef.current) {
      updateCrepeContent(crepeRef.current, value);
    }
    // Also sync to raw markdown ref
    rawMarkdownRef.current = value;
  }, [selectedField, alternateGreetingIndex, drafts, getFieldValue]);

  const currentValue = drafts[selectedField] ?? '';
  const images = useAuthoredImageUrls(currentValue);
  const imageKey = JSON.stringify(images.urls);

  const normalizeDraft = (value: string) => value.replace(/^(\s*)\\\[/gm, '$1[');

  // Create refs to always access current values without recreating callbacks
  const selectedFieldRef = useRef(selectedField);
  useEffect(() => {
    selectedFieldRef.current = selectedField;
  }, [selectedField]);

  // Handle WYSIWYG editor changes - sync to raw editor if it doesn't have focus
  const handleDraftChange = useCallback(
    (value: string) => {
      const normalized = normalizeDraft(value);
      const currentField = selectedFieldRef.current;
      setDrafts((prev) => ({ ...prev, [currentField]: normalized }));

      // Sync to raw markdown if it doesn't have focus
      if (editorFocus !== 'raw') {
        rawMarkdownRef.current = normalized;
      }
    },
    [editorFocus]
  );

  // Handle raw markdown editor changes - sync to WYSIWYG if it doesn't have focus
  const handleRawMarkdownChange = useCallback(
    (value: string) => {
      const normalized = normalizeDraft(value);
      const currentField = selectedFieldRef.current;
      rawMarkdownRef.current = normalized;
      setDrafts((prev) => ({ ...prev, [currentField]: normalized }));

      // Sync to Crepe editor if it doesn't have focus
      if (editorFocus !== 'wysiwyg' && crepeRef.current) {
        updateCrepeContent(crepeRef.current, normalized);
      }
    },
    [editorFocus]
  );

  if (!currentCard || !cardData) {
    return <div className="p-6 text-center text-dark-muted">Load a card to use Focused Mode.</div>;
  }

  const applyChanges = () => {
    if (!readFocusField(selectedField).editable) return;
    const value = drafts[selectedField] ?? '';
    if (selectedField === 'first_mes' && alternateGreetingIndex >= 0) {
      const greetings = [...(cardData.alternate_greetings as string[])];
      greetings[alternateGreetingIndex] = value;
      updateCardData({ alternate_greetings: greetings });
      return;
    }
    const definition = getFieldById(selectedField)!;
    const change = writeFieldValue(definition, cardData as unknown as Record<string, unknown>, value);
    updateCardData({ [change.field]: change.value } as Partial<CCv2Data>);
  };

  const resetCurrentField = () => {
    const baseValue = getFieldValue(selectedField);
    setDrafts((prev) => ({ ...prev, [selectedField]: baseValue }));
    // Use programmatic update instead of recreating editor
    if (crepeRef.current) {
      updateCrepeContent(crepeRef.current, baseValue);
    }
    // Also sync to raw markdown
    rawMarkdownRef.current = baseValue;
  };

  const handleAddAlternateGreeting = () => {
    if (!readFieldValue(getFieldById('alternate_greetings')!, cardData as unknown as Record<string, unknown>).editable) return;
    const greetings = [...(cardData?.alternate_greetings || [])];
    greetings.push('');

    if (isV3) {
      updateCardData({
        data: {
          ...(currentCard.data as CCv3Data).data,
          alternate_greetings: greetings,
        },
      } as Partial<CCv3Data>);
    } else {
      updateCardData({ alternate_greetings: greetings } as Partial<CCv2Data>);
    }

    // Select the new greeting
    setAlternateGreetingIndex(greetings.length - 1);
  };

  const handleDeleteAlternateGreeting = () => {
    if (!readFieldValue(getFieldById('alternate_greetings')!, cardData as unknown as Record<string, unknown>).editable) return;
    if (alternateGreetingIndex < 0) return; // Can't delete First Message
    if (!confirm('Delete this alternate greeting?')) return;

    const greetings = [...(cardData?.alternate_greetings || [])];
    greetings.splice(alternateGreetingIndex, 1);

    if (isV3) {
      updateCardData({
        data: {
          ...(currentCard.data as CCv3Data).data,
          alternate_greetings: greetings,
        },
      } as Partial<CCv3Data>);
    } else {
      updateCardData({ alternate_greetings: greetings } as Partial<CCv2Data>);
    }

    // Go back to previous greeting or First Message
    if (greetings.length === 0) {
      setAlternateGreetingIndex(-1);
    } else if (alternateGreetingIndex >= greetings.length) {
      setAlternateGreetingIndex(greetings.length - 1);
    }
  };

  const handleApplyTemplate = (template: Template, mode: 'replace' | 'append' | 'prepend') => {
    if (!readFocusField(selectedField).editable) return;
    if (template.targetFields === 'all') {
      // Apply to all fields - show confirmation
      if (!confirm(`This will ${mode} content in all fields. Continue?`)) {
        return;
      }

      const newDrafts: Record<LocalFocusField, string> = { ...drafts };
      Object.entries(template.content).forEach(([field, content]) => {
        // template.content keys are FocusField (from schema), cast to LocalFocusField
        const localField = field as LocalFocusField;
        if (!readFocusField(localField).editable) return;
        const currentValue = newDrafts[localField] ?? '';

        if (mode === 'replace') {
          newDrafts[localField] = content ?? '';
        } else if (mode === 'append') {
          newDrafts[localField] = currentValue + '\n\n' + (content ?? '');
        } else if (mode === 'prepend') {
          newDrafts[localField] = (content ?? '') + '\n\n' + currentValue;
        }
      });

      setDrafts(newDrafts);

      // Update current field's editor
      const updatedValue = newDrafts[selectedField];
      if (crepeRef.current) {
        updateCrepeContent(crepeRef.current, updatedValue);
      }
      rawMarkdownRef.current = updatedValue;
    } else {
      // Apply to current field only
      // Skip alternate_greetings since it's not a valid template field
      if (selectedField === 'alternate_greetings') {
        alert('Templates cannot be applied to alternate greetings.');
        return;
      }
      const content = template.content[selectedField as FocusField];
      if (!content) {
        alert(`This template does not have content for the ${selectedField} field.`);
        return;
      }

      const currentValue = drafts[selectedField] ?? '';
      let newValue = '';

      if (mode === 'replace') {
        newValue = content;
      } else if (mode === 'append') {
        newValue = currentValue + '\n\n' + content;
      } else if (mode === 'prepend') {
        newValue = content + '\n\n' + currentValue;
      }

      setDrafts((prev) => ({ ...prev, [selectedField]: newValue }));

      if (crepeRef.current) {
        updateCrepeContent(crepeRef.current, newValue);
      }
      rawMarkdownRef.current = newValue;
    }
  };

  const handleInsertSnippet = (snippet: Snippet) => {
    if (!readFocusField(selectedField).editable) return;
    const currentValue = drafts[selectedField] ?? '';
    // Simple append for now - could be enhanced to insert at cursor position
    const newValue = currentValue + snippet.content;

    setDrafts((prev) => ({ ...prev, [selectedField]: newValue }));

    if (crepeRef.current) {
      updateCrepeContent(crepeRef.current, newValue);
    }
    rawMarkdownRef.current = newValue;
  };

  const handleLLMApply = (value: string, action: 'replace' | 'append' | 'insert') => {
    if (!readFocusField(selectedField).editable) return;
    const currentValue = drafts[selectedField] ?? '';
    let newValue = '';

    if (action === 'replace') {
      newValue = value;
    } else if (action === 'append') {
      newValue = currentValue + '\n\n' + value;
    } else {
      // insert - same as append for now
      newValue = currentValue + '\n\n' + value;
    }

    setDrafts((prev) => ({ ...prev, [selectedField]: newValue }));

    if (crepeRef.current) {
      updateCrepeContent(crepeRef.current, newValue);
    }
    rawMarkdownRef.current = newValue;
  };

  // Check if we should use HTML mode for current field
  const isHtmlMode = selectedField === 'creator_notes' && creatorNotes.htmlMode;

  const renderWysiwyg = (suffix = '') => (
    <div className="flex-1 bg-slate-900/60 border border-dark-border rounded-lg p-3 overflow-auto min-h-[50vh]">
      <CrepeMarkdownEditor
        key={`${editorKey}-${suffix}`}
        value={currentValue}
        editorKey={editorKey}
        imageKey={imageKey}
        imageUrl={(source) => Object.hasOwn(images.urls, source) ? images.urls[source]! : unavailableImage}
        onChange={handleDraftChange}
        onReady={(instance) => {
          crepeRef.current = instance;
          rawMarkdownRef.current = currentValue;
        }}
      />
      {images.missing.length > 0 && <p role="status" className="mt-2 text-xs text-dark-muted">{images.missing.length} image reference{images.missing.length === 1 ? '' : 's'} unavailable or not stored. External images are not loaded; the original references are unchanged.</p>}
    </div>
  );

  // Render HTML editor (CodeMirror with HTML syntax) for HTML mode
  const renderHtmlEditor = () => (
    <div
      className="flex-1 bg-slate-900/60 border border-dark-border rounded-lg overflow-hidden min-h-[50vh]"
      onFocus={() => setEditorFocus('wysiwyg')}
      onBlur={() => setEditorFocus(null)}
    >
      <CodeMirror
        value={currentValue}
        height="100%"
        theme={githubDark}
        extensions={[codemirrorHtml(), EditorView.lineWrapping]}
        onChange={(value) => {
          handleDraftChange(value);
          rawMarkdownRef.current = value;
        }}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
        }}
        style={{ fontSize: '14px', height: '100%' }}
      />
    </div>
  );

  // Render HTML preview panel for HTML mode
  const renderHtmlPreview = () => (
    <div className="flex-1 flex flex-col border-l border-dark-border bg-dark-surface">
      {/* Preview Header */}
      <div className="flex h-10 items-center justify-between border-b border-dark-border bg-dark-bg px-4 py-2">
        <span className="text-sm font-medium">HTML Preview</span>
        <span className="text-xs text-dark-muted px-2 py-1 bg-green-900/30 rounded">Live</span>
      </div>

      {/* HTML Preview Content */}
      <div className="flex-1 overflow-auto p-4">
        <AuthoredHtml className="prose prose-invert max-w-none" html={currentValue} />
      </div>
    </div>
  );

  // Render collapsible control panel with CodeMirror (playground pattern)
  const renderControlPanel = () => {
    if (!showRawPanel) {
      return (
        <div className="absolute top-[10px] right-6 flex flex-col gap-2 z-10">
          <button
            onClick={() => setShowRawPanel(true)}
            className="flex h-12 w-12 items-center justify-center rounded-sm bg-dark-surface/90 border border-dark-border hover:bg-dark-bg transition-colors"
            title="Show raw markdown"
          >
            <span className="text-2xl">‹</span>
          </button>
        </div>
      );
    }

    return (
      <div className="flex-shrink-0 w-1/2 flex flex-col border-l border-dark-border bg-dark-surface">
        {/* Control Panel Header */}
        <div className="flex h-10 items-center justify-between border-b border-dark-border bg-dark-bg px-4 py-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRawPanel(false)}
              className="flex h-8 w-8 items-center justify-center rounded hover:bg-dark-surface transition-colors"
              title="Hide raw markdown"
            >
              <span className="text-base">›</span>
            </button>
            <span className="text-sm font-medium">Raw Markdown</span>
          </div>
        </div>

        {/* CodeMirror Editor */}
        <div
          className="flex-1 overflow-auto"
          onFocus={() => setEditorFocus('raw')}
          onBlur={() => setEditorFocus(null)}
        >
          <CodeMirror
            value={rawMarkdownRef.current}
            height="100%"
            theme={githubDark}
            extensions={[codemirrorMarkdown(), EditorView.lineWrapping]}
            onChange={handleRawMarkdownChange}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
            }}
            style={{ fontSize: '15px' }}
          />
        </div>
      </div>
    );
  };

  const greetingState = readFieldValue(getFieldById('alternate_greetings')!, cardData as unknown as Record<string, unknown>);
  const alternateGreetings = greetingState.editable && Array.isArray(greetingState.value) ? greetingState.value as string[] : [];
  const hasAlternateGreetings = alternateGreetings.length > 0;
  const selectedState = readFocusField(selectedField);
  const fieldLabel = ALL_FIELDS.find(field => field.id === selectedField)?.label ?? selectedField;

  return (
    <div className="h-full flex flex-col bg-dark-bg">
      {/* Field Selector Header */}
      <div className="bg-dark-surface border-b border-dark-border px-4 py-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {focusableFields.map((field) => (
              <button
                key={field.id}
                onClick={() => {
                  setSelectedField(field.id as LocalFocusField);
                }}
                className={`px-3 py-1.5 rounded transition-colors text-sm font-medium flex items-center gap-1 ${
                  selectedField === field.id
                    ? field.tag === 'VOX'
                      ? 'bg-orange-600 text-white border border-orange-400'
                      : field.tag === 'Ext'
                        ? 'bg-green-600 text-white border border-green-400'
                        : field.id === 'creator_notes' && creatorNotes.htmlMode
                          ? 'bg-green-600 text-white border border-green-400'
                          : 'bg-blue-600 text-white border border-blue-400'
                    : 'bg-dark-bg text-dark-text border border-dark-border hover:bg-dark-surface'
                }`}
              >
                {field.label}
                {field.tag && (
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded ${
                      field.tag === 'VOX'
                        ? 'bg-orange-800 text-orange-200'
                        : 'bg-green-800 text-green-200'
                    }`}
                  >
                    {field.tag}
                  </span>
                )}
                {field.id === 'creator_notes' && creatorNotes.htmlMode && !field.tag && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-green-800 text-green-200">
                    HTML
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowTemplatePanel(true)}
              disabled={!selectedState.editable}
              className="text-base px-1.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              title="Templates & Snippets"
            >
              📄
            </button>
            <button
              onClick={() => setLLMAssistOpen(true)}
              disabled={!selectedState.editable || !session.capabilities.browserLLM}
              className="text-base px-1.5 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
              title="AI Assist"
            >
              ✨
            </button>
            <button onClick={resetCurrentField} disabled={!selectedState.editable} className="btn-secondary px-3 py-1.5 text-sm">
              Reset
            </button>
            <button onClick={applyChanges} disabled={!selectedState.editable} className="btn-primary px-3 py-1.5 text-sm">
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Greetings Controls - First Message + Alt Greetings dropdown */}
      {selectedField === 'first_mes' && (
        <div className="bg-dark-surface border-b border-dark-border px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-dark-muted">Select:</span>
            <select
              value={alternateGreetingIndex}
              onChange={(e) => setAlternateGreetingIndex(parseInt(e.target.value, 10))}
              className="px-3 py-1.5 bg-dark-bg border border-dark-border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value={-1}>First Message</option>
              {alternateGreetings.map((_, idx) => (
                <option key={idx} value={idx}>
                  Alt Greeting {idx + 1}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddAlternateGreeting}
              disabled={!greetingState.editable}
              className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm transition-colors"
            >
              + Add Alt
            </button>
            {alternateGreetingIndex >= 0 && hasAlternateGreetings && (
              <button
                onClick={handleDeleteAlternateGreeting}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm transition-colors"
              >
                Delete
              </button>
            )}
          </div>
          {!greetingState.editable && <PreservedField label="Alternate Greetings" value={greetingState.value} />}
        </div>
      )}

      <div className="flex-1 flex flex-col p-6 space-y-4 relative">
        {/* Editor Container with relative positioning for chevron */}
        <div className="flex-1 flex gap-4 min-h-0 relative">
          {!selectedState.editable ? <PreservedField label={fieldLabel} value={selectedState.value} /> : isHtmlMode ? (
            <>
              {/* HTML Mode: Code editor on left, preview on right */}
              {renderHtmlEditor()}
              {renderHtmlPreview()}
            </>
          ) : (
            <>
              {/* Markdown Mode: WYSIWYG editor with collapsible raw panel */}
              <div
                className="flex-1 flex"
                onFocus={() => setEditorFocus('wysiwyg')}
                onBlur={() => setEditorFocus(null)}
              >
                {renderWysiwyg('single')}
              </div>

              {/* Collapsible Control Panel */}
              {renderControlPanel()}
            </>
          )}

          {/* LLM Assist Sidebar - positioned within editor area */}
          {llmAssistOpen && selectedState.editable && session.capabilities.browserLLM && (
            <LLMAssistSidebar
              isOpen={llmAssistOpen}
              onClose={() => setLLMAssistOpen(false)}
              fieldName={selectedField as CCFieldName}
              currentValue={currentValue}
              onApply={handleLLMApply}
              cardSpec={currentCard?.meta.spec ? normalizeSpec(currentCard.meta.spec) : 'v3'}
            />
          )}
        </div>

        <div className="text-xs text-dark-muted">
          {isHtmlMode ? (
            <>
              <span className="font-semibold">HTML Mode:</span> Edit HTML source code on the left,
              see live preview on the right. HTML is sanitized for safety.
            </>
          ) : (
            <>
              <span className="font-semibold">Tip:</span> WYSIWYG editor - Press Shift+Enter for
              line breaks, Enter for paragraph breaks. Use the ‹ button to toggle raw markdown view.
            </>
          )}
        </div>
      </div>

      {/* Template & Snippet Panel */}
      <TemplateSnippetPanel
        isOpen={showTemplatePanel}
        onClose={() => setShowTemplatePanel(false)}
        onApplyTemplate={handleApplyTemplate}
        onInsertSnippet={handleInsertSnippet}
        currentField={
          selectedField === 'alternate_greetings' ? 'description' : (selectedField as FocusField)
        }
      />
    </div>
  );
}

export function FocusedEditor() {
  return (
    <MilkdownProvider>
      <FocusedEditorInner />
    </MilkdownProvider>
  );
}
