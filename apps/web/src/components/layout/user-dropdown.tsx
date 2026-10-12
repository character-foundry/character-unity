'use client';

import { useEffect, useRef, useState } from 'react';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';

/** Internal profile: no accounts, just display preferences. Hub sign-in replaces this in the hub profile. */
export function UserDropdown() {
  const { settings, updateSettings } = useSettings();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button onClick={() => setIsOpen(!isOpen)} className="p-2 rounded-lg hover:bg-cosmic-teal/30 transition-colors text-starlight/80" title="Display settings">
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-60 glass rounded-lg border border-nebula/30 shadow-xl py-2 z-50 text-sm">
          <label className="flex items-center justify-between px-4 py-2 hover:bg-cosmic-teal/30 cursor-pointer">
            <span>Blur NSFW images</span>
            <input type="checkbox" checked={settings.blurNsfwContent} onChange={(event) => updateSettings({ blurNsfwContent: event.target.checked })} />
          </label>
          <div className="px-4 py-2">
            <div className="mb-1 text-starlight/60">Card size</div>
            <div className="flex gap-2">
              {(['normal', 'large'] as const).map((size) => (
                <button key={size} onClick={() => updateSettings({ cardSize: size })}
                  className={cn('px-2 py-1 rounded capitalize', settings.cardSize === size ? 'bg-nebula/30 text-nebula' : 'bg-cosmic-teal/30 text-starlight/70')}>
                  {size}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
