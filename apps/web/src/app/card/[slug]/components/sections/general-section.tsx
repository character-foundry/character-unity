'use client';

import type { CardDetail } from '@/types/card';

interface GeneralSectionProps {
  cardData: CardDetail['cardData'];
  tokens: CardDetail['tokens'];
}

interface FieldProps {
  title: string;
  content: string;
  tokenCount: number;
}

function Field({ title, content, tokenCount }: FieldProps) {
  return (
    <div>
      <h3 className="font-semibold mb-2 text-starlight/80 flex items-center gap-2">
        {title}
        <span className="text-xs text-starlight/50">({tokenCount.toLocaleString()} tokens)</span>
      </h3>
      <pre className="whitespace-pre-wrap text-sm text-starlight/70 bg-cosmic-teal/30 p-4 rounded-lg overflow-x-auto">
        {content}
      </pre>
    </div>
  );
}

export function GeneralSection({ cardData, tokens }: GeneralSectionProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold gradient-text">General</h2>

      {cardData.data.description && (
        <Field
          title="Description"
          content={cardData.data.description}
          tokenCount={tokens.description}
        />
      )}

      {cardData.data.personality && (
        <Field
          title="Personality"
          content={cardData.data.personality}
          tokenCount={tokens.personality}
        />
      )}

      {cardData.data.scenario && (
        <Field
          title="Scenario"
          content={cardData.data.scenario}
          tokenCount={tokens.scenario}
        />
      )}

      {/* Visual Description / Appearance - future use */}
      {typeof cardData.data.extensions?.visual_description === 'string' && cardData.data.extensions.visual_description && (
        <Field
          title="Visual Description (Appearance)"
          content={cardData.data.extensions.visual_description}
          tokenCount={0}
        />
      )}

      {!cardData.data.description && !cardData.data.personality && !cardData.data.scenario && (
        <p className="text-starlight/50 italic">No general information provided.</p>
      )}
    </div>
  );
}
