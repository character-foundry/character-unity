import type { CardDetail, TokenBreakdown } from '@/types/card';
import { Collapsible, Accordion } from '@/components/ui';

interface CharacterSectionProps { cardData: CardDetail['cardData']; tokens: TokenBreakdown | null; rawDocument: unknown }
const fields: { title: string; key: 'description' | 'personality' | 'scenario' | 'system_prompt' | 'post_history_instructions' | 'mes_example'; token: keyof TokenBreakdown }[] = [
  { title: 'Description', key: 'description', token: 'description' }, { title: 'Personality', key: 'personality', token: 'personality' },
  { title: 'Scenario', key: 'scenario', token: 'scenario' }, { title: 'System Prompt', key: 'system_prompt', token: 'systemPrompt' },
  { title: 'Post History Instructions', key: 'post_history_instructions', token: 'postHistory' }, { title: 'Example Messages', key: 'mes_example', token: 'mesExample' },
];

export function CharacterSection({ cardData, tokens, rawDocument }: CharacterSectionProps) {
  const { data } = cardData;
  const depth = data.extensions.depth_prompt;
  const prompt = depth && typeof depth === 'object' && !Array.isArray(depth) ? (depth as Record<string, unknown>).prompt : null;
  const depthValue = depth && typeof depth === 'object' && !Array.isArray(depth) ? (depth as Record<string, unknown>).depth : null;
  const appearance = data.extensions.visual_description;
  return <div data-section="character">
    <h2 className="gradient-text mb-4 text-xl font-semibold" data-section-title>Character Card</h2>
    <Accordion>
      <Collapsible title="Character" defaultOpen><p className="text-starlight/80">{data.name || 'Untitled'}</p>{data.creator && <p className="mt-2 text-sm text-starlight/60">by {data.creator}</p>}{data.character_version && <p className="mt-2 text-xs text-starlight/50">Version: {data.character_version}</p>}</Collapsible>
      {fields.filter(({ key }) => data[key]).map(({ title, key, token }) => <Collapsible key={key} title={title}
        badge={tokens ? <span className="text-xs text-starlight/50">{tokens[token].toLocaleString()} tokens</span> : undefined}>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-cosmic-teal/30 p-4 text-sm text-starlight/70">{data[key]}</pre>
      </Collapsible>)}
      {typeof appearance === 'string' && appearance && <Collapsible title="Appearance"><pre className="whitespace-pre-wrap break-words text-sm text-starlight/70">{appearance}</pre></Collapsible>}
      {typeof prompt === 'string' && prompt && <Collapsible title="Character Note"
        badge={typeof depthValue === 'number' && Number.isFinite(depthValue) ? <span className="text-xs text-nebula">depth: {depthValue}</span> : undefined}><pre className="whitespace-pre-wrap break-words text-sm text-starlight/70">{prompt}</pre></Collapsible>}
      <details className="rounded-lg border border-nebula/20 p-4"><summary className="cursor-pointer text-sm text-starlight/80">Original document fields</summary>
        <p className="my-3 text-xs text-starlight/50">Full saved data, including extensions and fields not interpreted by this viewer.</p>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-starlight/60">{JSON.stringify(rawDocument, null, 2)}</pre>
      </details>
    </Accordion>
  </div>;
}
