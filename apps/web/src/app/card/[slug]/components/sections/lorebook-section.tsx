'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui';

interface LorebookEntry {
  keys?: string[] | null;
  content?: string | null;
  enabled?: boolean | null;
  name?: string | null;
  comment?: string | null;
  insertion_order?: number | null;
}

interface CharacterBook {
  name?: string | null;
  scan_depth?: number | null;
  token_budget?: number | null;
  recursive_scanning?: boolean | null;
  entries: LorebookEntry[];
}

interface LorebookSectionProps {
  characterBook: CharacterBook;
}

export function LorebookSection({ characterBook }: LorebookSectionProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(
    characterBook.entries.length > 0 ? 0 : null
  );

  const selectedEntry = selectedIndex !== null ? characterBook.entries[selectedIndex] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold gradient-text">
          {characterBook.name || 'Lorebook'} ({characterBook.entries.length} entries)
        </h2>
      </div>

      {/* Lorebook metadata */}
      <div className="flex flex-wrap gap-4 text-xs text-starlight/60 mb-4">
        {characterBook.scan_depth != null && (
          <div>
            <span className="text-starlight/40">Scan Depth:</span>{' '}
            <span>{characterBook.scan_depth}</span>
          </div>
        )}
        {characterBook.token_budget != null && (
          <div>
            <span className="text-starlight/40">Token Budget:</span>{' '}
            <span>{characterBook.token_budget}</span>
          </div>
        )}
        {characterBook.recursive_scanning != null && (
          <div>
            <span className="text-starlight/40">Recursive:</span>{' '}
            <span>{characterBook.recursive_scanning ? 'Yes' : 'No'}</span>
          </div>
        )}
      </div>

      {characterBook.entries.length === 0 ? (
        <p className="text-starlight/50 italic">No lorebook entries.</p>
      ) : (
        <div className="flex gap-4 min-h-[400px]">
          {/* Left column - Entry list (1/4) */}
          <div className="w-1/4 min-w-[200px] bg-cosmic-teal/20 rounded-lg overflow-hidden">
            <div className="p-2 border-b border-nebula/20">
              <span className="text-xs text-starlight/50 uppercase font-semibold">Entries</span>
            </div>
            <div className="overflow-y-auto max-h-[360px]">
              {characterBook.entries.map((entry, index) => {
                const keyLabel = entry.keys && entry.keys.length > 0 ? entry.keys.join(', ') : '';
                const displayName = entry.comment || entry.name || keyLabel || `Entry ${index + 1}`;
                const isSelected = selectedIndex === index;

                return (
                  <button
                    key={index}
                    onClick={() => setSelectedIndex(index)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-nebula/10 transition-colors ${
                      isSelected
                        ? 'bg-nebula/30 text-starlight'
                        : 'text-starlight/70 hover:bg-cosmic-teal/30'
                    } ${!entry.enabled ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-starlight/40">#{index + 1}</span>
                      <span className="truncate">{displayName}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right column - Entry details (3/4) */}
          <div className="flex-1 bg-cosmic-teal/20 rounded-lg p-4 overflow-y-auto max-h-[400px]">
            {selectedEntry ? (
              <div className="space-y-4">
                {/* Entry name/comment */}
                {(selectedEntry.name || selectedEntry.comment) && (
                  <div>
                    <span className="text-xs text-starlight/40 uppercase">Name</span>
                    <p className="text-starlight/80">
                      {selectedEntry.name || selectedEntry.comment}
                    </p>
                  </div>
                )}

                {/* Status */}
                <div className="flex items-center gap-2">
                  {selectedEntry.enabled === false ? (
                    <Badge variant="warning" size="sm">Disabled</Badge>
                  ) : (
                    <Badge variant="success" size="sm">Enabled</Badge>
                  )}
                  {selectedEntry.insertion_order != null && (
                    <span className="text-xs text-starlight/40">
                      Order: {selectedEntry.insertion_order}
                    </span>
                  )}
                </div>

                {/* Keys */}
                <div>
                  <span className="text-xs text-starlight/40 uppercase block mb-2">Keys</span>
                  <div className="flex flex-wrap gap-2">
                    {(selectedEntry.keys || []).map((key, i) => (
                      <Badge key={i} variant="info" size="sm">{key}</Badge>
                    ))}
                  </div>
                </div>

                {/* Content */}
                <div>
                  <span className="text-xs text-starlight/40 uppercase block mb-2">Content</span>
                  <pre className="whitespace-pre-wrap text-sm text-starlight/70 bg-deep-space/50 p-4 rounded-lg">
                    {selectedEntry.content || ''}
                  </pre>
                </div>
              </div>
            ) : (
              <p className="text-starlight/50 italic">Select an entry to view details.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
