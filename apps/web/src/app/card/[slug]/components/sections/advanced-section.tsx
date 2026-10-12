'use client';

import type { CardDetail } from '@/types/card';
import type { CardExtensions } from '../utils';

interface AdvancedSectionProps {
  cardData: CardDetail['cardData'];
  tokens: CardDetail['tokens'];
}

interface FieldProps {
  title: string;
  content: string;
  tokenCount?: number;
  note?: string;
}

function Field({ title, content, tokenCount, note }: FieldProps) {
  return (
    <div>
      <h3 className="font-semibold mb-2 text-starlight/80 flex items-center gap-2">
        {title}
        {tokenCount !== undefined && (
          <span className="text-xs text-starlight/50">({tokenCount.toLocaleString()} tokens)</span>
        )}
        {note && (
          <span className="text-xs text-nebula">({note})</span>
        )}
      </h3>
      <pre className="whitespace-pre-wrap text-sm text-starlight/70 bg-cosmic-teal/30 p-4 rounded-lg overflow-x-auto">
        {content}
      </pre>
    </div>
  );
}

export function AdvancedSection({ cardData, tokens }: AdvancedSectionProps) {
  const extensions = cardData.data.extensions as CardExtensions | undefined;
  const depthPrompt = extensions?.depth_prompt;

  const hasContent = depthPrompt?.prompt ||
                     cardData.data.system_prompt ||
                     cardData.data.post_history_instructions ||
                     cardData.data.mes_example;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold gradient-text">Advanced</h2>

      {/* Character Note / Depth Prompt */}
      {depthPrompt?.prompt && (
        <Field
          title="Character Note"
          content={depthPrompt.prompt}
          note={`depth: ${depthPrompt.depth || 4}`}
        />
      )}

      {/* System Prompt */}
      {cardData.data.system_prompt && (
        <Field
          title="System Prompt"
          content={cardData.data.system_prompt}
          tokenCount={tokens.systemPrompt}
        />
      )}

      {/* Post History Instructions */}
      {cardData.data.post_history_instructions && (
        <Field
          title="Post History Instructions"
          content={cardData.data.post_history_instructions}
          tokenCount={tokens.postHistory}
        />
      )}

      {/* Example Dialogs */}
      {cardData.data.mes_example && (
        <Field
          title="Example Dialogs"
          content={cardData.data.mes_example}
          tokenCount={tokens.mesExample}
        />
      )}

      {!hasContent && (
        <p className="text-starlight/50 italic">No advanced settings provided.</p>
      )}
    </div>
  );
}
