'use client';

import { cn } from '@/lib/utils/cn';

export type Section = 'notes' | 'character' | 'greetings' | 'lorebook' | 'assets' | 'comments';

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
    <div className="glass rounded-none border-y border-nebula/20 mb-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
      <nav className="flex overflow-x-auto">
        {sections.filter(s => s.available).map((section) => (
          <button
            key={section.id}
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
