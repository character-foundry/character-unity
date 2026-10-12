'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { Input } from './input';
import { cn } from '@/lib/utils/cn';

export interface TagInfo {
  id: number;
  name: string;
  slug: string;
  category: string | null;
}

interface TagChipSelectorProps {
  label: string;
  description?: string;
  selectedTags: TagInfo[];
  availableTags: TagInfo[];
  onAdd: (tag: TagInfo) => void;
  onRemove: (tagId: number) => void;
  variant?: 'green' | 'red' | 'blue';
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
}

export function TagChipSelector({
  label,
  description,
  selectedTags,
  availableTags,
  onAdd,
  onRemove,
  variant = 'blue',
  placeholder = 'Search tags...',
  disabled = false,
  isLoading = false,
}: TagChipSelectorProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const variantClasses = {
    green: {
      chip: 'bg-green-500/20 text-green-400',
      chipHover: 'hover:bg-green-500/30',
      removeHover: 'hover:text-green-300',
      icon: 'text-green-400',
    },
    red: {
      chip: 'bg-red-500/20 text-red-400',
      chipHover: 'hover:bg-red-500/30',
      removeHover: 'hover:text-red-300',
      icon: 'text-red-400',
    },
    blue: {
      chip: 'bg-nebula/20 text-nebula',
      chipHover: 'hover:bg-nebula/30',
      removeHover: 'hover:text-nebula/80',
      icon: 'text-nebula',
    },
  };

  const classes = variantClasses[variant];

  // Filter tags by search term, excluding already selected
  const filteredTags = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase();
    const selectedIds = new Set(selectedTags.map(t => t.id));
    return availableTags
      .filter(tag =>
        !selectedIds.has(tag.id) &&
        (tag.name.toLowerCase().includes(term) || tag.slug.includes(term))
      )
      .slice(0, 8);
  }, [availableTags, searchTerm, selectedTags]);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAddTag = (tag: TagInfo) => {
    onAdd(tag);
    setSearchTerm('');
    setIsOpen(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="font-medium text-starlight mb-1">{label}</div>
        {description && (
          <div className="text-sm text-starlight/60">{description}</div>
        )}
      </div>

      {/* Selected chips */}
      {selectedTags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {selectedTags.map(tag => (
            <span
              key={tag.id}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm',
                classes.chip
              )}
            >
              {tag.name}
              <button
                type="button"
                onClick={() => onRemove(tag.id)}
                disabled={disabled}
                className={cn('transition-colors', classes.removeHover)}
                title="Remove"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-sm text-starlight/40 italic">None selected</p>
      )}

      {/* Search input */}
      <div ref={containerRef} className="relative">
        <Input
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled || isLoading}
        />

        {/* Dropdown */}
        {isOpen && filteredTags.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-cosmic-teal border border-nebula/30 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
            {filteredTags.map(tag => (
              <button
                key={tag.slug}
                type="button"
                onClick={() => handleAddTag(tag)}
                className="w-full px-3 py-2 text-left text-sm text-starlight hover:bg-nebula/20 flex items-center justify-between"
              >
                <span>{tag.name}</span>
                {tag.category && (
                  <span className="text-starlight/40 text-xs">{tag.category}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
