/**
 * EditPanel V2 - Schema-driven character card editor
 *
 * This is a refactored version of EditPanel that uses configuration-driven
 * field rendering instead of hardcoded JSX. It reduces the code by ~80%
 * while maintaining all functionality.
 *
 * Key changes:
 * - Field definitions in config/field-definitions.ts
 * - DynamicField component for field binding
 * - FieldRenderer for type-specific rendering
 * - Tab content generated from configuration
 */

import { useEditorSession } from '../../../unity/context';
import { useState, useEffect, useId } from 'react';
import { useCardStore, extractCardData } from '../../../store/card-store';
import { useSettingsStore } from '../../../store/settings-store';
import { useTokenStore } from '../../../store/token-store';
import { useLLMStore } from '../../../store/llm-store';
import { EditorImage } from '../../../unity/media';
import {
  normalizeSpec,
  type FocusField,
  type Template,
  type Snippet,
  type LLMProvider,
} from '../../../lib/types';

import { DynamicField } from './DynamicField';
import { LorebookEditor } from './LorebookEditor';
import { LLMAssistSidebar } from './LLMAssistSidebar';
import { TemplateSnippetPanel } from './TemplateSnippetPanel';

import { getFieldsForTab, tabDefinitions, type TabId } from '../config/field-definitions';

// ============================================================================
// TYPES
// ============================================================================

type EditTab = TabId | 'lorebook' | 'extensions';

// ============================================================================
// AVATAR UPLOAD COMPONENT (Special handling, not schema-driven)
// ============================================================================

function AvatarUpload() {
  const session = useEditorSession();
  const editorAssets = session.assets;
  useCardStore((state) => state.currentCard);
  const selection = session.selection();
  const inputId = useId();
  const [imageUrl, setImageUrl] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setImageUrl('');
    setError(null);
    setIsUploading(false);
    const refresh = async () => {
      const card = session.cards.getState().currentCard;
      if (!card) return;
      try {
        const assets = await editorAssets.list(card);
        if (active && session.selection() === selection) {
          setImageUrl(assets.find((asset) => asset.portrait)?.url ?? '');
          setImageFailed(false);
        }
      } catch (err) {
        if (active && session.selection() === selection) setError(err instanceof Error ? err.message : 'Failed to load portrait');
      }
    };
    void refresh();
    const unsubscribe = editorAssets.subscribe(() => { queueMicrotask(() => { if (active) void refresh(); }); });
    return () => { active = false; unsubscribe(); };
  }, [session, editorAssets, selection]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    const card = session.cards.getState().currentCard;
    if (!file || !card) return;
    const signal = session.liveSignal();
    const live = () => session.selection() === selection && !signal.aborted;
    setIsUploading(true);
    setError(null);
    try {
      await editorAssets.setPortrait(card, file);
      if (live()) {
        session.cards.setState({ isDirty: true });
      }
    } catch (err) {
      if (live()) setError(err instanceof Error ? err.message : 'Failed to add portrait');
    } finally {
      if (live()) {
        setIsUploading(false);
        input.value = '';
      }
    }
  };

  return (
    <div className="flex flex-col items-center">
      <div className="w-[300px] bg-dark-bg border border-dark-border rounded overflow-hidden mb-2">
        {imageUrl && !imageFailed ? (
          <EditorImage
            src={imageUrl}
            alt="Character Avatar"
            className="w-full h-auto"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex items-center justify-center text-dark-muted text-sm w-full h-48">
            No Image
          </div>
        )}
      </div>
      <label htmlFor={inputId} className="btn-secondary inline-flex px-3 py-2 rounded-lg text-sm cursor-pointer focus-within:ring-2 focus-within:ring-blue-500">
        {isUploading ? 'Adding portrait...' : 'Upload Image'}
        <input
          id={inputId}
          type="file"
          accept="image/*"
          aria-label="Choose portrait"
          className="sr-only"
          onChange={handleUpload}
          disabled={isUploading}
        />
      </label>
      {error && <p role="alert" className="text-sm text-red-300 mt-2 max-w-[300px]">{error}</p>}
      <p className="text-xs text-dark-muted mt-2">Portrait changes are saved with the card.</p>
    </div>
  );
}

// ============================================================================
// EXTENSIONS TAB (Read-only JSON view)
// ============================================================================

interface ExtensionsViewProps {
  cardData: Record<string, unknown>;
}

function ExtensionsView({ cardData }: ExtensionsViewProps) {
  // Filter out handled extensions
  const getFilteredExtensions = () => {
    const extensions = { ...((cardData.extensions as Record<string, unknown>) || {}) };

    // Remove handled extensions
    delete extensions.depth_prompt;
    delete extensions.visual_description;

    // Keep voxta but remove appearance if showing separately
    if (extensions.voxta) {
      const voxtaCopy = { ...(extensions.voxta as Record<string, unknown>) };
      delete voxtaCopy.appearance;
      if (Object.keys(voxtaCopy).length === 0) {
        delete extensions.voxta;
      } else {
        extensions.voxta = voxtaCopy;
      }
    }

    return extensions;
  };

  const filtered = getFilteredExtensions();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">Extensions Data</h3>
        <p className="text-dark-muted">
          Read-only view of extension data. Character Note and Appearance are edited in the Advanced
          and Character tabs.
        </p>
      </div>

      <div className="bg-dark-surface border border-dark-border rounded-lg p-4">
        <pre className="text-sm text-dark-text whitespace-pre-wrap overflow-auto max-h-[60vh] font-mono">
          {JSON.stringify(filtered, null, 2) || '{}'}
        </pre>
      </div>

      {Object.keys(filtered).length === 0 && (
        <p className="text-dark-muted text-center py-4">No additional extension data present.</p>
      )}
    </div>
  );
}

// ============================================================================
// TAB CONTENT RENDERER
// ============================================================================

interface TabContentProps {
  tab: TabId;
  cardData: Record<string, unknown>;
  spec: 'v2' | 'v3';
  showV3Fields: boolean;
  tokenCounts: Record<string, number>;
  onFieldChange: (field: string, value: unknown) => void;
  onOpenLLMAssist: (fieldName: string, value: string) => void;
  onOpenTemplates: (fieldName: FocusField, value: string) => void;
  llmSettings: { providers: LLMProvider[]; activeProviderId?: string };
  aiPrompts: { tagsSystemPrompt: string; taglineSystemPrompt: string };
  // Package ID for timestamps
  packageId?: string;
}

function TabContent({
  tab,
  cardData,
  spec,
  showV3Fields,
  tokenCounts,
  onFieldChange,
  onOpenLLMAssist,
  onOpenTemplates,
  llmSettings,
  aiPrompts,
}: TabContentProps) {
  const fields = getFieldsForTab(tab);

  if (tab === 'basic') {
    const coreFieldIds = ['name', 'nickname', 'creator', 'character_version'];
    const coreFields = fields.filter((f) => coreFieldIds.includes(f.id));
    const fullWidthFields = fields.filter((f) => !coreFieldIds.includes(f.id));

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6">
          <div className="flex justify-center md:justify-start">
            <AvatarUpload />
          </div>

          <div className="space-y-4">
            {coreFields.map((field) => (
              <DynamicField
                key={field.id}
                definition={field}
                cardData={cardData}
                onFieldChange={onFieldChange}
                spec={spec}
                showV3Fields={showV3Fields}
                tokenCounts={tokenCounts}
                onOpenLLMAssist={onOpenLLMAssist}
                onOpenTemplates={onOpenTemplates}
                llmSettings={llmSettings}
                aiPrompts={aiPrompts}
              />
            ))}
          </div>
        </div>

        {fullWidthFields.map((field) => (
          <DynamicField
            key={field.id}
            definition={field}
            cardData={cardData}
            onFieldChange={onFieldChange}
            spec={spec}
            showV3Fields={showV3Fields}
            tokenCounts={tokenCounts}
            onOpenLLMAssist={onOpenLLMAssist}
            onOpenTemplates={onOpenTemplates}
            llmSettings={llmSettings}
            aiPrompts={aiPrompts}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {fields.map((field) => (
        <DynamicField
          key={field.id}
          definition={field}
          cardData={cardData}
          onFieldChange={onFieldChange}
          spec={spec}
          showV3Fields={showV3Fields}
          tokenCounts={tokenCounts}
          onOpenLLMAssist={onOpenLLMAssist}
          onOpenTemplates={onOpenTemplates}
          llmSettings={llmSettings}
          aiPrompts={aiPrompts}
        />
      ))}
    </div>
  );
}

// ============================================================================
// MAIN EDIT PANEL COMPONENT
// ============================================================================

export function EditPanelV2() {
  const { currentCard, updateCardData, updateCardMeta } = useCardStore();
  const { editor, aiPrompts } = useSettingsStore();
  const tokenCounts = useTokenStore((state) => state.tokenCounts);
  const { settings: llmSettings, loadSettings } = useLLMStore();

  const [activeTab, setActiveTab] = useState<EditTab>('basic');

  // LLM Assist sidebar state
  const [llmAssistOpen, setLLMAssistOpen] = useState(false);
  const [llmAssistField, setLLMAssistField] = useState<string>('description');
  const [llmAssistValue, setLLMAssistValue] = useState('');

  // Templates panel state
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templatesField, setTemplatesField] = useState<FocusField>('description');
  const [templatesValue, setTemplatesValue] = useState('');


  // Load LLM settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Early return if no card
  if (!currentCard) return null;

  const isV3 = currentCard.meta.spec === 'v3';
  const cardData = extractCardData(currentCard) as unknown as Record<string, unknown>;
  const spec = normalizeSpec(currentCard.meta.spec);
  const showV3Fields = editor.showV3Fields;

  // Field change handler
  const handleFieldChange = (field: string, value: unknown) => {
    const v2Data = currentCard.data as unknown as Record<string, unknown>;
    const isWrappedV2 = !isV3 && v2Data.spec === 'chara_card_v2' && 'data' in v2Data;

    if (isV3 || isWrappedV2) {
      updateCardData({
        data: {
          ...cardData,
          [field]: value,
        },
      } as Record<string, unknown>);
    } else {
      updateCardData({ [field]: value });
    }

    // Special handling for tags - also update meta.tags
    if (field === 'tags') {
      updateCardMeta({ tags: value as string[] });
    }
  };

  // LLM Assist handlers
  const handleOpenLLMAssist = (fieldName: string, value: string) => {
    setLLMAssistField(fieldName);
    setLLMAssistValue(value);
    setLLMAssistOpen(true);
  };

  const handleLLMApply = (value: string, action: 'replace' | 'append' | 'insert') => {
    // Handle appearance field
    if (llmAssistField === 'appearance') {
      const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
      const extensions = { ...existingExtensions };
      const currentAppearance = getAppearanceFromExtensions(extensions);

      if (extensions.voxta) {
        (extensions.voxta as Record<string, unknown>).appearance =
          action === 'replace' ? value : currentAppearance + '\n' + value;
      } else {
        extensions.visual_description =
          action === 'replace' ? value : currentAppearance + '\n' + value;
      }
      handleFieldChange('extensions', extensions);
      return;
    }

    // Handle character_note field
    if (llmAssistField === 'character_note') {
      const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
      const depthPrompt = (existingExtensions.depth_prompt || {}) as Record<string, unknown>;
      const currentPrompt = (depthPrompt.prompt as string) || '';
      const depth = (depthPrompt.depth as number) ?? 4;

      const extensions = {
        ...existingExtensions,
        depth_prompt: {
          prompt: action === 'replace' ? value : currentPrompt + '\n' + value,
          depth,
          role: 'system',
        },
      };
      handleFieldChange('extensions', extensions);
      return;
    }

    // Handle alternate_greetings array items
    if (llmAssistField.startsWith('alternate_greetings:')) {
      const index = parseInt(llmAssistField.split(':')[1], 10);
      if (!isNaN(index) && cardData.alternate_greetings) {
        const updated = [...(cardData.alternate_greetings as string[])];
        if (action === 'replace') updated[index] = value;
        else if (action === 'append') updated[index] = updated[index] + '\n' + value;
        handleFieldChange('alternate_greetings', updated);
      }
      return;
    }

    // Standard field handling
    if (action === 'replace') {
      handleFieldChange(llmAssistField, value);
    } else if (action === 'append') {
      handleFieldChange(llmAssistField, llmAssistValue + '\n' + value);
    }
  };

  // Templates handlers
  const handleOpenTemplates = (fieldName: FocusField, value: string) => {
    setTemplatesField(fieldName);
    setTemplatesValue(value);
    setTemplatesOpen(true);
  };

  const handleApplyTemplate = (template: Template, mode: 'replace' | 'append' | 'prepend') => {
    const content = template.content[templatesField];
    if (!content) {
      alert(`This template does not have content for the ${templatesField} field.`);
      return;
    }

    let newValue = '';
    if (mode === 'replace') {
      newValue = content;
    } else if (mode === 'append') {
      newValue = templatesValue + '\n\n' + content;
    } else if (mode === 'prepend') {
      newValue = content + '\n\n' + templatesValue;
    }

    handleFieldChange(templatesField, newValue);
  };

  const handleInsertSnippet = (snippet: Snippet) => {
    const newValue = templatesValue + snippet.content;
    handleFieldChange(templatesField, newValue);
  };

  // Determine card type for tab filtering
  const cardSpec = currentCard.meta.spec;
  const isLorebook = cardSpec === 'lorebook';
  const isCollection = cardSpec === 'collection';

  // Build tabs list based on card type
  const tabs: Array<{ id: EditTab; label: string }> = (() => {
    if (isLorebook) {
      // Lorebooks: Basic Info, Lorebook, Extensions
      return [
        { id: 'basic' as EditTab, label: 'Basic Info' },
        { id: 'lorebook' as EditTab, label: 'Lorebook' },
        ...(editor.showExtensionsTab ? [{ id: 'extensions' as EditTab, label: 'Extensions' }] : []),
      ];
    }

    if (isCollection) {
      // Collections: Basic Info, Character, Extensions
      return [
        { id: 'basic' as EditTab, label: 'Basic Info' },
        { id: 'character' as EditTab, label: 'Character' },
        ...(editor.showExtensionsTab ? [{ id: 'extensions' as EditTab, label: 'Extensions' }] : []),
      ];
    }

    // Character cards: All tabs
    return [
      ...tabDefinitions.map((t) => ({ id: t.id as EditTab, label: t.label })),
      ...(editor.showExtensionsTab ? [{ id: 'extensions' as EditTab, label: 'Extensions' }] : []),
    ];
  })();

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* Tab Navigation */}
      <div className="bg-dark-surface border-b border-dark-border">
        <div className="flex items-center justify-between">
          <div className="flex overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-sm whitespace-nowrap font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-dark-bg text-dark-text border-b-2 border-blue-500'
                    : 'text-dark-muted hover:text-dark-text'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 relative flex">
        <div
          className={`standard-editor-content overflow-y-auto p-4 sm:p-6 space-y-6 w-full ${llmAssistOpen ? 'with-assistant' : 'max-w-6xl mx-auto'}`}
        >
          {/* Schema-driven tabs */}
          {(activeTab === 'basic' ||
            activeTab === 'character' ||
            activeTab === 'greetings' ||
            activeTab === 'advanced') && (
            <TabContent
              tab={activeTab}
              cardData={cardData}
              spec={spec === 'collection' || spec === 'lorebook' ? 'v3' : spec}
              showV3Fields={showV3Fields}
              tokenCounts={tokenCounts}
              onFieldChange={handleFieldChange}
              onOpenLLMAssist={handleOpenLLMAssist}
              onOpenTemplates={handleOpenTemplates}
              llmSettings={llmSettings}
              aiPrompts={aiPrompts}
              packageId={currentCard.meta.packageId}
            />
          )}

          {/* Lorebook Tab - separate component */}
          {activeTab === 'lorebook' && <LorebookEditor />}

          {/* Extensions Tab - read-only view */}
          {activeTab === 'extensions' && <ExtensionsView cardData={cardData} />}
        </div>

        {/* LLM Assist Sidebar */}
        {llmAssistOpen && (
          <LLMAssistSidebar
            isOpen={llmAssistOpen}
            onClose={() => setLLMAssistOpen(false)}
            fieldName={llmAssistField}
            currentValue={llmAssistValue}
            onApply={handleLLMApply}
            cardSpec={normalizeSpec(currentCard.meta.spec)}
          />
        )}
      </div>

      {/* Templates Panel */}
      <TemplateSnippetPanel
        isOpen={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onApplyTemplate={handleApplyTemplate}
        onInsertSnippet={handleInsertSnippet}
        currentField={templatesField}
      />
    </div>
  );
}

// Helper function for appearance
function getAppearanceFromExtensions(extensions: Record<string, unknown>): string {
  if ((extensions.voxta as Record<string, unknown> | undefined)?.appearance) {
    return (extensions.voxta as Record<string, unknown>).appearance as string;
  }
  if (extensions.visual_description) {
    return extensions.visual_description as string;
  }
  return '';
}
