'use client';

import { cn } from '@/lib/utils/cn';

export type FeedSortOption = 'for_you' | 'newest' | 'modified' | 'upvotes' | 'downloads' | 'favorites';
export type SortOrder = 'asc' | 'desc';

interface FeedSortControlsProps {
  sort: FeedSortOption;
  order: SortOrder;
  onSortChange: (sort: FeedSortOption) => void;
  onOrderChange: (order: SortOrder) => void;
  showForYou?: boolean;
}

const sortOptions: { value: FeedSortOption; label: string }[] = [
  { value: 'for_you', label: 'For You' },
  { value: 'newest', label: 'Newest' },
  { value: 'modified', label: 'Modified' },
  { value: 'upvotes', label: 'Upvotes' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'favorites', label: 'Favorites' },
];

export function FeedSortControls({
  sort,
  order,
  onSortChange,
  onOrderChange,
  showForYou = true,
}: FeedSortControlsProps) {
  const filteredOptions = showForYou
    ? sortOptions
    : sortOptions.filter(o => o.value !== 'for_you');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Sort options */}
      <div className="flex flex-wrap gap-1">
        {filteredOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => onSortChange(option.value)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm transition-colors',
              sort === option.value
                ? 'bg-nebula/30 text-nebula border border-nebula/50'
                : 'bg-cosmic-teal/30 text-starlight/70 hover:bg-cosmic-teal/50 hover:text-starlight border border-transparent'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Order toggle - only show for sortable options */}
      {sort !== 'for_you' && (
        <button
          onClick={() => onOrderChange(order === 'asc' ? 'desc' : 'asc')}
          className="p-1.5 rounded-lg bg-cosmic-teal/30 text-starlight/70 hover:bg-cosmic-teal/50 hover:text-starlight transition-colors"
          title={order === 'asc' ? 'Ascending (oldest first)' : 'Descending (newest first)'}
        >
          {order === 'asc' ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
