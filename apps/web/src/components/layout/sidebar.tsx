'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';

interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  {
    name: 'Library',
    href: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v12a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z" />
      </svg>
    ),
  },
  {
    name: 'Search',
    href: '/search',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
];

// Archive search, presets and lorebooks land here as they are ported.
const secondaryNavItems: NavItem[] = [
  {
    name: 'Chat apps',
    href: '/chat-apps',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { settings, updateSettings } = useSettings();
  const isExpanded = settings.sidebarExpanded;

  const toggleExpanded = () => {
    updateSettings({ sidebarExpanded: !isExpanded });
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-40 h-screen pt-16 lg:translate-x-0',
          'bg-deep-space/95 backdrop-blur-lg border-r border-nebula/20',
          'transition-all duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : '-translate-x-full',
          isExpanded ? 'w-64' : 'w-16'
        )}
      >
        <div className="flex flex-col h-full px-3 py-4 overflow-hidden">
          {/* Main navigation */}
          <nav className="flex-1 space-y-1">
            <div className={cn(
              'text-xs font-semibold text-starlight/50 uppercase tracking-wider px-3 mb-2 transition-all duration-300 overflow-hidden',
              isExpanded ? 'opacity-100 h-4' : 'opacity-0 h-0'
            )}>
              Navigation
            </div>
            {navItems.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                onClick={onClose}
                title={!isExpanded ? item.name : undefined}
                className={cn(
                  'flex items-center rounded-lg transition-all duration-200 overflow-hidden',
                  isExpanded ? 'gap-3 px-3 py-2.5' : 'justify-center px-2 py-2.5',
                  pathname === item.href
                    ? 'bg-nebula/20 text-nebula'
                    : 'text-starlight/70 hover:bg-cosmic-teal/30 hover:text-starlight'
                )}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                <span className={cn(
                  'whitespace-nowrap transition-all duration-300',
                  isExpanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
                )}>
                  {item.name}
                </span>
              </Link>
            ))}

            <div className={cn(
              'text-xs font-semibold text-starlight/50 uppercase tracking-wider px-3 mt-6 mb-2 transition-all duration-300 overflow-hidden',
              isExpanded ? 'opacity-100 h-4' : 'opacity-0 h-0 mt-4'
            )}>
              {secondaryNavItems.length > 0 ? 'More' : ''}
            </div>
            {secondaryNavItems.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                onClick={onClose}
                title={!isExpanded ? item.name : undefined}
                className={cn(
                  'flex items-center rounded-lg transition-all duration-200 overflow-hidden',
                  isExpanded ? 'gap-3 px-3 py-2.5' : 'justify-center px-2 py-2.5',
                  !isExpanded && item.name === 'Favorites' && 'mt-4',
                  pathname === item.href
                    ? 'bg-nebula/20 text-nebula'
                    : 'text-starlight/70 hover:bg-cosmic-teal/30 hover:text-starlight'
                )}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                <span className={cn(
                  'whitespace-nowrap transition-all duration-300',
                  isExpanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
                )}>
                  {item.name}
                </span>
              </Link>
            ))}
          </nav>

          {/* Collapse toggle (desktop only) */}
          <button
            onClick={toggleExpanded}
            className={cn(
              'hidden lg:flex items-center rounded-lg text-starlight/50 hover:text-starlight hover:bg-cosmic-teal/30 transition-all duration-200 overflow-hidden',
              isExpanded ? 'gap-3 px-3 py-2.5' : 'justify-center px-2 py-2.5'
            )}
            title={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <svg
              className={cn('w-5 h-5 flex-shrink-0 transition-transform duration-300', !isExpanded && 'rotate-180')}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            <span className={cn(
              'whitespace-nowrap transition-all duration-300',
              isExpanded ? 'opacity-100 w-auto' : 'opacity-0 w-0'
            )}>
              Collapse
            </span>
          </button>

          {/* Footer */}
          <div className={cn(
            'pt-4 border-t border-nebula/20 transition-all duration-300 overflow-hidden',
            isExpanded ? 'opacity-100' : 'opacity-0 h-0 pt-0 border-0'
          )}>
            <div className="px-3 text-xs text-starlight/40">
              <div>Character Unity</div>
              <div>Local library</div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
