'use client';

import type { CardDetail } from '@/types/card';
import { Collapsible, Accordion } from '@/components/ui';
import type { CardExtensions } from '../utils';

interface CharacterSectionProps {
  cardData: CardDetail['cardData'];
  tokens: CardDetail['tokens'];
}

interface FieldContentProps {
  content: string;
  tokenCount?: number;
  note?: string;
}

function FieldContent({ content, tokenCount, note }: FieldContentProps) {
  return (
    <div>
      {(tokenCount !== undefined || note) && (
        <div className="flex items-center gap-2 mb-2 text-xs text-starlight/50">
          {tokenCount !== undefined && <span>{tokenCount.toLocaleString()} tokens</span>}
          {note && <span className="text-nebula">{note}</span>}
        </div>
      )}
      <pre className="whitespace-pre-wrap text-sm text-starlight/70 bg-cosmic-teal/30 p-4 rounded-lg overflow-x-auto">
        {content}
      </pre>
    </div>
  );
}

export function CharacterSection({ cardData, tokens }: CharacterSectionProps) {
  const extensions = cardData.data.extensions as CardExtensions | undefined;
  const depthPrompt = extensions?.depth_prompt;
  const visualDescription = typeof extensions?.visual_description === 'string'
    ? extensions.visual_description
    : undefined;

  // Check what content exists
  const hasDescription = !!cardData.data.description;
  const hasPersonality = !!cardData.data.personality;
  const hasScenario = !!cardData.data.scenario;
  const hasAppearance = !!visualDescription;
  const hasCharacterNote = !!depthPrompt?.prompt;
  const hasSystemPrompt = !!cardData.data.system_prompt;
  const hasPostHistory = !!cardData.data.post_history_instructions;
  const hasExamples = !!cardData.data.mes_example;

  const hasAnyContent = hasDescription || hasPersonality || hasScenario ||
    hasAppearance || hasCharacterNote || hasSystemPrompt || hasPostHistory || hasExamples;

  if (!hasAnyContent) {
    return (
      <div data-section="character">
        <h2 className="text-xl font-semibold mb-4 gradient-text" data-section-title>Character Card</h2>
        <p className="text-starlight/50 italic">No character information provided.</p>
      </div>
    );
  }

  return (
    <div data-section="character">
      <h2 className="text-xl font-semibold mb-4 gradient-text" data-section-title>Character Card</h2>

      <Accordion>
        {/* Character Name is shown in hero, but include it if creator field exists */}
        {cardData.data.name && (
          <Collapsible
            title="Character"
            defaultOpen
            badge={<span className="text-xs text-starlight/50">name</span>}
          >
            <p className="text-starlight/80">{cardData.data.name}</p>
            {cardData.data.creator && (
              <p className="text-sm text-starlight/60 mt-2">by {cardData.data.creator}</p>
            )}
          </Collapsible>
        )}

        {hasDescription && (
          <Collapsible
            title="Description"
            badge={
              <span className="text-xs text-starlight/50">
                {tokens.description.toLocaleString()} tokens
                <span className="ml-2 text-amber-400/80">⚠️ spoiler warning</span>
              </span>
            }
          >
            <FieldContent content={cardData.data.description!} />
          </Collapsible>
        )}

        {hasScenario && (
          <Collapsible
            title="Scenario"
            badge={<span className="text-xs text-starlight/50">{tokens.scenario.toLocaleString()} tokens</span>}
          >
            <FieldContent content={cardData.data.scenario!} />
          </Collapsible>
        )}

        {hasPersonality && (
          <Collapsible
            title="Personality"
            badge={<span className="text-xs text-starlight/50">{tokens.personality.toLocaleString()} tokens</span>}
          >
            <FieldContent content={cardData.data.personality!} />
          </Collapsible>
        )}

        {hasAppearance && (
          <Collapsible
            title="Appearance"
            badge={<span className="text-xs text-nebula">visual_description</span>}
          >
            <FieldContent content={visualDescription!} />
          </Collapsible>
        )}

        {hasCharacterNote && (
          <Collapsible
            title="Character Note"
            badge={<span className="text-xs text-nebula">depth: {depthPrompt?.depth || 4}</span>}
          >
            <FieldContent content={depthPrompt!.prompt} />
          </Collapsible>
        )}

        {hasSystemPrompt && (
          <Collapsible
            title="System Prompt"
            badge={<span className="text-xs text-starlight/50">{tokens.systemPrompt.toLocaleString()} tokens</span>}
          >
            <FieldContent content={cardData.data.system_prompt!} />
          </Collapsible>
        )}

        {hasPostHistory && (
          <Collapsible
            title="Post History Instructions"
            badge={<span className="text-xs text-starlight/50">{tokens.postHistory.toLocaleString()} tokens</span>}
          >
            <FieldContent content={cardData.data.post_history_instructions!} />
          </Collapsible>
        )}

        {hasExamples && (
          <Collapsible
            title="Example Messages"
            badge={<span className="text-xs text-starlight/50">{tokens.mesExample.toLocaleString()} tokens</span>}
          >
            <FieldContent content={cardData.data.mes_example!} />
          </Collapsible>
        )}

        {/* Extensions - show raw if there are other extensions besides known ones */}
        {extensions && Object.keys(extensions).some(k =>
          !['depth_prompt', 'visual_description', 'chub', 'risuai', 'fav', 'talkativeness'].includes(k)
        ) && (
          <Collapsible
            title="Extensions"
            badge={<span className="text-xs text-nebula">raw data</span>}
          >
            <pre className="whitespace-pre-wrap text-xs text-starlight/60 bg-cosmic-teal/30 p-4 rounded-lg overflow-x-auto">
              {JSON.stringify(
                Object.fromEntries(
                  Object.entries(extensions).filter(([k]) =>
                    !['depth_prompt', 'visual_description', 'chub', 'risuai', 'fav', 'talkativeness'].includes(k)
                  )
                ),
                null,
                2
              )}
            </pre>
          </Collapsible>
        )}
      </Accordion>
    </div>
  );
}
