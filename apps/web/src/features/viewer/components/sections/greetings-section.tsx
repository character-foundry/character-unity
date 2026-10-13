import { Badge, Collapsible, Accordion } from '@/components/ui';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { RenderTextWithImages } from '../utils';

interface GreetingsSectionProps {
  firstMessage: string; alternateGreetings: string[]; groupGreetings: string[]; firstMessageTokens?: number; isNsfw?: boolean;
}

export function GreetingsSection({ firstMessage, alternateGreetings, groupGreetings, firstMessageTokens, isNsfw }: GreetingsSectionProps) {
  const { settings } = useSettings();
  const greetings = [
    ...(firstMessage.trim() ? [{ label: 'Default Greeting', kind: 'Default', text: firstMessage, tokens: firstMessageTokens }] : []),
    ...alternateGreetings.map((text, index) => ({ label: `Greeting ${index + 2}`, kind: 'Alt', text, tokens: undefined })),
    ...groupGreetings.map((text, index) => ({ label: `Group Greeting ${index + 1}`, kind: 'Group only', text, tokens: undefined })),
  ];
  return <div data-section="greetings">
    <h2 className="gradient-text mb-4 flex items-center gap-2 text-xl font-semibold" data-section-title>Greetings <span className="text-sm font-normal text-starlight/50">({greetings.length} total)</span></h2>
    <Accordion>{greetings.map((greeting, index) => <Collapsible key={greeting.label} title={greeting.label} defaultOpen={index === 0}
      badge={<div className="flex items-center gap-2"><Badge variant={greeting.kind === 'Default' ? 'success' : 'info'} size="sm">{greeting.kind}</Badge>{greeting.tokens !== undefined && <span className="text-xs text-starlight/50">{greeting.tokens.toLocaleString()} tokens</span>}</div>}>
      <div className={cn('whitespace-pre-wrap break-words text-sm text-starlight/70', settings.blurNsfwContent && isNsfw && 'blur-md select-none')}><RenderTextWithImages text={greeting.text} centered halfSize /></div>
    </Collapsible>)}</Accordion>
  </div>;
}
