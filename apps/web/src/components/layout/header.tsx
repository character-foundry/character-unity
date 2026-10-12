'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserDropdown } from './user-dropdown';

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const router = useRouter();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/?search=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch(e);
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 nav-blur border-b border-nebula/20">
      <div className="flex items-center justify-between h-16 px-4">
        {/* Left side - Menu button and logo */}
        <div className="flex items-center gap-4">
          <button
            onClick={onMenuClick}
            className="p-2 rounded-lg hover:bg-cosmic-teal/30 transition-colors lg:hidden"
          >
            <svg className="w-6 h-6 text-starlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 cosmic-gradient rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">CU</span>
            </div>
            <span className="font-bold text-xl gradient-text hidden sm:inline">Character Unity</span>
          </Link>
        </div>

        {/* Center - Search bar */}
        <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-4">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-starlight/60"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search characters..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full bg-cosmic-teal/30 border border-nebula/30 rounded-lg px-4 py-2 pl-10 text-starlight placeholder-starlight/50 focus:outline-none focus:border-nebula transition-colors"
            />
          </div>
        </form>

        {/* Right side - User dropdown */}
        <div className="flex items-center">
          <UserDropdown />
        </div>
      </div>
    </header>
  );
}
