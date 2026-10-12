'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import type { SortOption } from '@/types/card';

interface Tag {
  id: number;
  name: string;
  slug: string;
  category: string | null;
}

interface TagGroup {
  category: string;
  tags: Tag[];
}

interface CardFiltersProps {
  tags: TagGroup[];
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  sort: SortOption;
  onSortChange: (sort: SortOption) => void;
}

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'trending', label: 'Trending' },
  { value: 'popular', label: 'Popular' },
  { value: 'downloads', label: 'Most Downloads' },
  { value: 'rating', label: 'Highest Rated' },
];

const categoryOrder = ['gender', 'pov', 'genre', 'type', 'rating', 'theme', 'species'];

export function CardFilters({
  tags,
  selectedTags,
  onTagsChange,
  sort,
  onSortChange,
}: CardFiltersProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['gender', 'pov', 'genre'])
  );

  const toggleTag = (slug: string) => {
    if (selectedTags.includes(slug)) {
      onTagsChange(selectedTags.filter((t) => t !== slug));
    } else {
      onTagsChange([...selectedTags, slug]);
    }
  };

  const toggleCategory = (category: string) => {
    const newExpanded = new Set(expandedCategories);
    if (newExpanded.has(category)) {
      newExpanded.delete(category);
    } else {
      newExpanded.add(category);
    }
    setExpandedCategories(newExpanded);
  };

  const clearFilters = () => {
    onTagsChange([]);
  };

  // Sort tags by category order
  const sortedTags = [...tags].sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a.category);
    const bIndex = categoryOrder.indexOf(b.category);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });

  return (
    <div className="space-y-6">
      {/* Sort tabs */}
      <div className="flex flex-wrap gap-2">
        {sortOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => onSortChange(option.value)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              sort === option.value
                ? 'cosmic-gradient text-white'
                : 'bg-cosmic-teal/30 text-starlight/70 hover:text-starlight hover:bg-cosmic-teal/50'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Active filters */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-starlight/60">Active filters:</span>
          {selectedTags.map((slug) => {
            const tag = tags
              .flatMap((g) => g.tags)
              .find((t) => t.slug === slug);
            return (
              <button
                key={slug}
                onClick={() => toggleTag(slug)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-nebula text-white text-sm"
              >
                {tag?.name || slug}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            );
          })}
          <button
            onClick={clearFilters}
            className="text-sm text-solar hover:text-solar/80"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Tag categories */}
      <div className="space-y-4">
        {sortedTags.map((group) => (
          <div key={group.category} className="space-y-2">
            <button
              onClick={() => toggleCategory(group.category)}
              className="flex items-center gap-2 text-sm font-semibold text-starlight/80 hover:text-starlight"
            >
              <svg
                className={cn(
                  'w-4 h-4 transition-transform',
                  expandedCategories.has(group.category) ? 'rotate-90' : ''
                )}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {group.category.charAt(0).toUpperCase() + group.category.slice(1)}
            </button>

            {expandedCategories.has(group.category) && (
              <div className="flex flex-wrap gap-2 pl-6">
                {group.tags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.slug)}
                    className={cn(
                      'filter-tag px-3 py-1 rounded-full text-sm',
                      selectedTags.includes(tag.slug) && 'active'
                    )}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
