import { cn } from '@/lib/utils/cn';

export type Section = 'notes' | 'character' | 'greetings' | 'lorebook' | 'assets' | 'forks';

interface SectionConfig {
  id: Section;
  label: string;
  available: boolean;
}

interface SectionTabsProps {
  sections: SectionConfig[];
  activeSection: Section;
  onSectionChange: (section: Section) => void;
}

export function SectionTabs({ sections, activeSection, onSectionChange }: SectionTabsProps) {
  return (
    <div className="glass mb-6 min-w-0 max-w-full rounded-xl border border-nebula/20">
      <nav aria-label="Card sections" className="flex overflow-x-auto">
        {sections.filter(s => s.available).map((section) => (
          <button
            key={section.id}
            type="button"
            aria-pressed={activeSection === section.id}
            onClick={() => onSectionChange(section.id)}
            className={cn(
              'px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
              activeSection === section.id
                ? 'border-nebula text-nebula'
                : 'border-transparent text-starlight/60 hover:text-starlight hover:border-starlight/30'
            )}
          >
            {section.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
