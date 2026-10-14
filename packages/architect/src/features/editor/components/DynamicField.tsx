/**
 * DynamicField - Binds FieldRenderer to card data
 *
 * This component:
 * - Gets value from card data using field definition path
 * - Handles value changes and updates card data
 * - Manages special cases (appearance, extensions)
 * - Provides token counts and generates AI content
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { FieldRenderer } from './FieldRenderer';
import type { FieldDefinition } from '../config/field-definitions';
import { getValueByPath, setValueByPath, isFieldVisible } from '../config/field-definitions';
import type { FocusField, LLMProvider } from '../../../lib/types';
import { invokeClientLLM } from '../../../lib/client-llm';
import { clientProvider } from '../../../store/llm-store';
import { useEditorSession } from '../../../unity/context';

// ============================================================================
// PROPS INTERFACE
// ============================================================================

export interface DynamicFieldProps {
  /** Field definition from config */
  definition: FieldDefinition;
  /** Current card data (extracted from card) */
  cardData: Record<string, unknown>;
  /** Handler to update card field */
  onFieldChange: (field: string, value: unknown) => void;
  /** Current card spec */
  spec: 'v2' | 'v3';
  /** Whether to show V3 fields (from settings) */
  showV3Fields: boolean;
  /** Token counts object */
  tokenCounts: Record<string, number>;
  /** Handler for LLM assist */
  onOpenLLMAssist?: (fieldName: string, value: string) => void;
  /** Handler for templates */
  onOpenTemplates?: (fieldName: FocusField, value: string) => void;
  /** LLM settings for AI generation */
  llmSettings?: {
    providers: LLMProvider[];
    activeProviderId?: string;
  };
  /** AI prompts from settings */
  aiPrompts?: {
    tagsSystemPrompt: string;
    taglineSystemPrompt: string;
  };
}

// ============================================================================
// SPECIAL FIELD VALUE GETTERS
// ============================================================================

/**
 * Get appearance value - checks voxta extension first, then visual_description
 */
function getAppearanceValue(cardData: Record<string, unknown>): string {
  const extensions = (cardData.extensions || {}) as Record<string, unknown>;
  const voxta = extensions.voxta as Record<string, unknown> | undefined;
  if (voxta?.appearance) return voxta.appearance as string;
  if (extensions.visual_description) return extensions.visual_description as string;
  return '';
}

/**
 * Get character note value from depth_prompt extension
 */
function getCharacterNoteValue(cardData: Record<string, unknown>): string {
  const extensions = (cardData.extensions || {}) as Record<string, unknown>;
  const depthPrompt = extensions.depth_prompt as Record<string, unknown> | undefined;
  return (depthPrompt?.prompt as string) || '';
}

/**
 * Get character note depth from depth_prompt extension
 */
function getCharacterNoteDepth(cardData: Record<string, unknown>): number {
  const extensions = (cardData.extensions || {}) as Record<string, unknown>;
  const depthPrompt = extensions.depth_prompt as Record<string, unknown> | undefined;
  return (depthPrompt?.depth as number) ?? 4;
}

/**
 * Get value for a field, handling special cases
 */
function getFieldValue(definition: FieldDefinition, cardData: Record<string, unknown>): unknown {
  // Special case: appearance field
  if (definition.id === 'appearance') {
    return getAppearanceValue(cardData);
  }

  // Special case: character_note
  if (definition.id === 'character_note') {
    return getCharacterNoteValue(cardData);
  }

  // Special case: character_note_depth
  if (definition.id === 'character_note_depth') {
    return getCharacterNoteDepth(cardData);
  }

  // Special case: timestamps (read-only)
  if (definition.id === 'timestamps') {
    return {
      creation_date: (cardData as Record<string, unknown>).creation_date,
      modification_date: (cardData as Record<string, unknown>).modification_date,
      packageId: undefined, // This comes from meta, not data
    };
  }

  // Standard path-based value retrieval
  return getValueByPath(cardData, definition.path);
}

// ============================================================================
// SPECIAL FIELD VALUE SETTERS
// ============================================================================

/**
 * Set appearance value - prefers voxta extension if present
 */
function setAppearance(
  cardData: Record<string, unknown>,
  value: string,
  onFieldChange: (field: string, value: unknown) => void
): void {
  const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
  const extensions = { ...existingExtensions };

  // Prefer voxta extension if it exists, otherwise use visual_description
  if (extensions.voxta) {
    extensions.voxta = {
      ...(extensions.voxta as Record<string, unknown>),
      appearance: value,
    };
  } else {
    extensions.visual_description = value;
  }

  onFieldChange('extensions', extensions);
}

/**
 * Set character note value
 */
function setCharacterNote(
  cardData: Record<string, unknown>,
  value: string,
  onFieldChange: (field: string, value: unknown) => void
): void {
  const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
  const currentDepth = getCharacterNoteDepth(cardData);

  const extensions = {
    ...existingExtensions,
    depth_prompt: {
      ...((existingExtensions.depth_prompt || {}) as Record<string, unknown>),
      prompt: value,
      depth: currentDepth,
      role: 'system',
    },
  };

  onFieldChange('extensions', extensions);
}

/**
 * Set character note depth
 */
function setCharacterNoteDepth(
  cardData: Record<string, unknown>,
  depth: number,
  onFieldChange: (field: string, value: unknown) => void
): void {
  const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
  const currentPrompt = getCharacterNoteValue(cardData);

  const extensions = {
    ...existingExtensions,
    depth_prompt: {
      ...((existingExtensions.depth_prompt || {}) as Record<string, unknown>),
      prompt: currentPrompt,
      depth,
      role: 'system',
    },
  };

  onFieldChange('extensions', extensions);
}

/**
 * Set tagline in extensions
 */
function setTagline(
  cardData: Record<string, unknown>,
  value: string,
  onFieldChange: (field: string, value: unknown) => void
): void {
  const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
  const extensions = { ...existingExtensions, tagline: value };
  onFieldChange('extensions', extensions);
}

// ============================================================================
// DYNAMIC FIELD COMPONENT
// ============================================================================

export function DynamicField({
  definition,
  cardData,
  onFieldChange,
  spec,
  showV3Fields,
  tokenCounts,
  onOpenLLMAssist,
  onOpenTemplates,
  llmSettings,
  aiPrompts,
}: DynamicFieldProps) {
  const session = useEditorSession();
  const generation = session.selection();
  const [generating, setGenerating] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const fieldRef = useRef(definition.id);
  fieldRef.current = definition.id;

  useEffect(() => {
    setGenerating(false);
    return () => {
      const request = requestRef.current;
      requestRef.current = null;
      request?.abort();
    };
  }, [session, generation, definition.id]);

  // Check if field should be visible
  const hasVoxtaExtension = !!(cardData.extensions as Record<string, unknown> | undefined)?.voxta;
  const isVisible = isFieldVisible(definition, {
    spec,
    showV3Fields,
    hasVoxtaExtension,
  });

  // Get current value
  const value = useMemo(() => getFieldValue(definition, cardData), [definition, cardData]);

  // Get token count
  const tokenCount = useMemo(() => {
    if (!definition.showTokens || !definition.tokenKey) return undefined;
    return tokenCounts[definition.tokenKey];
  }, [definition, tokenCounts]);

  // Get item token counts for array fields
  const itemTokenCounts = useMemo(() => {
    if (definition.type !== 'array') return undefined;

    const counts: Record<string, number> = {};
    const items = (value as string[]) || [];

    items.forEach((_, index) => {
      const key = `${definition.id}_${index}`;
      // Map to the actual token count key format
      const tokenKey =
        definition.id === 'alternate_greetings'
          ? `alternate_greeting_${index}`
          : `${definition.id}_${index}`;
      if (tokenCounts[tokenKey] !== undefined) {
        counts[key] = tokenCounts[tokenKey];
      }
    });

    return counts;
  }, [definition, value, tokenCounts]);

  // Handle value change
  const handleChange = useCallback(
    (newValue: unknown) => {
      // Special case: appearance
      if (definition.id === 'appearance') {
        setAppearance(cardData, newValue as string, onFieldChange);
        return;
      }

      // Special case: character_note
      if (definition.id === 'character_note') {
        setCharacterNote(cardData, newValue as string, onFieldChange);
        return;
      }

      // Special case: character_note_depth
      if (definition.id === 'character_note_depth') {
        setCharacterNoteDepth(cardData, newValue as number, onFieldChange);
        return;
      }

      // Special case: tagline
      if (definition.id === 'tagline') {
        setTagline(cardData, newValue as string, onFieldChange);
        return;
      }

      // For simple top-level fields, use the path directly
      if (!definition.path.includes('.')) {
        onFieldChange(definition.path, newValue);
        return;
      }

      // For nested paths (extensions, etc.), update the parent object
      const parts = definition.path.split('.');
      if (parts[0] === 'extensions') {
        const existingExtensions = (cardData.extensions || {}) as Record<string, unknown>;
        const updated = setValueByPath(existingExtensions, parts.slice(1).join('.'), newValue);
        onFieldChange('extensions', updated);
      } else {
        // Generic nested path handling
        const updated = setValueByPath(cardData, definition.path, newValue);
        // This would need the parent to handle full object updates
        onFieldChange(parts[0], (updated as Record<string, unknown>)[parts[0]]);
      }
    },
    [definition, cardData, onFieldChange]
  );

  // Handle AI generation (tags, tagline)
  const handleGenerate = useCallback(async () => {
    if (!session.capabilities.browserLLM) return;
    if (!llmSettings || !aiPrompts) return;

    let activeProvider = llmSettings.providers.find(
      (p) => p.id === llmSettings.activeProviderId
    );
    if (!activeProvider && llmSettings.providers.length > 0) {
      activeProvider = llmSettings.providers[0];
    }
    if (!activeProvider) {
      alert('Please configure an LLM provider in Settings > AI > Providers first.');
      return;
    }

    const description = (cardData.description as string) || '';
    const name = (cardData.name as string) || 'Unknown';

    if (!description) {
      alert(`Please add a description first to generate ${definition.label.toLowerCase()}.`);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.liveSignal()]);
    const requestGeneration = session.selection();
    const requestField = definition.id;
    requestRef.current = controller;
    const isCurrentRequest = () => requestRef.current === controller &&
      !signal.aborted && sessionRef.current === session &&
      session.selection() === requestGeneration && fieldRef.current === requestField;
    const onAbort = () => {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setGenerating(false);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    setGenerating(true);

    try {
      let content = '';

      // Determine which AI prompt to use
      const isTagsField = definition.id === 'tags';
      const systemPrompt = isTagsField
        ? aiPrompts.tagsSystemPrompt
        : aiPrompts.taglineSystemPrompt;
      const userPrompt = isTagsField
        ? `Generate tags for this character:\n\nName: ${name}\n\nDescription:\n${description}`
        : `Write a short tagline for this character:\n\nName: ${name}\n\nDescription:\n${description}`;

      const result = await invokeClientLLM({
        provider: clientProvider(activeProvider),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: isTagsField ? 0.7 : 0.8,
        maxTokens: 200,
        signal,
      });
      if (!isCurrentRequest()) return;
      if (!result.success) throw new Error(result.error || 'LLM request failed');
      content = result.content || '';

      // Process the result
      if (isTagsField) {
        // Parse JSON array from response
        const jsonMatch = content.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const tags = JSON.parse(jsonMatch[0]) as string[];
          if (Array.isArray(tags) && tags.length > 0) {
            // Merge with existing tags, avoiding duplicates
            const existingTags = (value as string[]) || [];
            const newTags = [
              ...new Set([
                ...existingTags,
                ...tags.map((t: string) =>
                  t.toLowerCase().trim().replace(/\s+/g, '-')
                ),
              ]),
            ];
            handleChange(newTags);
          }
        }
      } else {
        // Tagline - just set the trimmed content
        const trimmed = content.trim().slice(0, 500);
        if (trimmed) {
          handleChange(trimmed);
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error(`Failed to generate ${definition.label.toLowerCase()}:`, err);
      alert(
        `Failed to generate ${definition.label.toLowerCase()}: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setGenerating(false);
      }
    }
  }, [
    definition,
    llmSettings,
    aiPrompts,
    cardData,
    value,
    handleChange,
    session,
  ]);

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  return (
    <FieldRenderer
      definition={definition}
      value={value}
      onChange={handleChange}
      tokenCount={tokenCount}
      generating={generating}
      onGenerate={definition.aiGenerate && session.capabilities.browserLLM ? handleGenerate : undefined}
      onOpenLLMAssist={session.capabilities.browserLLM ? onOpenLLMAssist : undefined}
      onOpenTemplates={onOpenTemplates}
      itemTokenCounts={itemTokenCounts}
    />
  );
}
