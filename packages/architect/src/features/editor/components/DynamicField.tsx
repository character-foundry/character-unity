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
import { isFieldVisible } from '../config/field-definitions';
import { readFieldValue, writeFieldValue } from './field-value';
import { isRecord } from '../../../lib/card-utils';
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
  const hasVoxtaExtension = isRecord(cardData.extensions) && Object.hasOwn(cardData.extensions, 'voxta');
  const isVisible = isFieldVisible(definition, {
    spec,
    showV3Fields,
    hasVoxtaExtension,
  });

  // Get current value
  const { value, editable } = useMemo(() => readFieldValue(definition, cardData), [definition, cardData]);

  // Get token count
  const tokenCount = useMemo(() => {
    if (!definition.showTokens || !definition.tokenKey) return undefined;
    return tokenCounts[definition.tokenKey];
  }, [definition, tokenCounts]);

  // Get item token counts for array fields
  const itemTokenCounts = useMemo(() => {
    if (definition.type !== 'array' || !Array.isArray(value)) return undefined;

    const counts: Record<string, number> = {};
    const items = value;

    items.forEach((_, index) => {
      const key = `${definition.id}_${index}`;
      // Map to the actual token count key format
      const tokenKey =
        definition.id === 'alternate_greetings'
          ? `alternate_greeting_${index}`
          : definition.id === 'group_only_greetings' ? `group_only_greeting_${index}`
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
      const updated = writeFieldValue(definition, cardData, newValue);
      onFieldChange(updated.field, updated.value);
    },
    [definition, cardData, onFieldChange]
  );

  // Handle AI generation (tags, tagline)
  const handleGenerate = useCallback(async () => {
    if (!editable || !session.capabilities.browserLLM) return;
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
          if (Array.isArray(tags) && tags.length > 0 && tags.every(tag => typeof tag === 'string')) {
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
    editable,
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
      editable={editable}
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
