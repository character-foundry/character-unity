'use client';

import { Badge, Collapsible, Accordion } from '@/components/ui';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { renderTextWithImages } from '../utils';

interface GreetingsSectionProps {
  firstMessage: string;
  alternateGreetings?: string[];
  firstMessageTokens: number;
  isNsfw?: boolean;
}

export function GreetingsSection({ firstMessage, alternateGreetings, firstMessageTokens, isNsfw }: GreetingsSectionProps) {
  const { settings } = useSettings();
  const shouldBlur = settings.blurNsfwContent && isNsfw;
  const totalGreetings = 1 + (alternateGreetings?.length || 0);

  return (
    <div data-section="greetings">
      <h2 className="text-xl font-semibold mb-4 gradient-text flex items-center gap-2" data-section-title>
        Greetings
        <span className="text-sm font-normal text-starlight/50">
          ({totalGreetings} total)
        </span>
      </h2>

      <Accordion>
        {/* Default Greeting */}
        <Collapsible
          title="Default Greeting"
          defaultOpen
          badge={
            <div className="flex items-center gap-2">
              <Badge variant="success" size="sm">Default</Badge>
              <span className="text-xs text-starlight/50">{firstMessageTokens.toLocaleString()} tokens</span>
            </div>
          }
        >
          <div className={cn(
            'whitespace-pre-wrap text-sm text-starlight/70 transition-all duration-300',
            shouldBlur && 'blur-md select-none'
          )}>
            {renderTextWithImages(firstMessage, { centered: true, halfSize: true })}
          </div>
        </Collapsible>

        {/* Alternate Greetings */}
        {alternateGreetings?.map((greeting, index) => (
          <Collapsible
            key={index}
            title={`Greeting ${index + 2}`}
            badge={<Badge variant="info" size="sm">Alt</Badge>}
          >
            <div className={cn(
              'whitespace-pre-wrap text-sm text-starlight/70 transition-all duration-300',
              shouldBlur && 'blur-md select-none'
            )}>
              {renderTextWithImages(greeting, { centered: true, halfSize: true })}
            </div>
          </Collapsible>
        ))}
      </Accordion>
    </div>
  );
}
