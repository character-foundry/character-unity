'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface CollapsibleProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  titleClassName?: string;
  contentClassName?: string;
  badge?: ReactNode;
  disabled?: boolean;
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  className,
  titleClassName,
  contentClassName,
  badge,
  disabled = false,
}: CollapsibleProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={cn('border border-nebula/20 rounded-lg overflow-hidden', className)} data-collapsible data-open={isOpen}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          'w-full flex items-center justify-between px-4 py-3 text-left',
          'bg-surface-1/50 hover:bg-surface-2/50 transition-colors',
          disabled && 'opacity-50 cursor-not-allowed',
          titleClassName
        )}
        data-collapsible-trigger
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-starlight">{title}</span>
          {badge}
        </div>
        <svg
          className={cn(
            'w-5 h-5 text-starlight/60 transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
        )}
        data-collapsible-content
      >
        <div className={cn('p-4 bg-surface-1/30', contentClassName)}>
          {children}
        </div>
      </div>
    </div>
  );
}

interface AccordionProps {
  children: ReactNode;
  className?: string;
}

export function Accordion({ children, className }: AccordionProps) {
  return (
    <div className={cn('space-y-2', className)} data-accordion>
      {children}
    </div>
  );
}
