'use client';

import { useState, type ReactNode } from 'react';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { settings } = useSettings();

  return (
    <div className="min-h-screen">
      <Header onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content */}
      <main className={cn(
        'pt-16 transition-all duration-300 ease-in-out',
        settings.sidebarExpanded ? 'lg:pl-64' : 'lg:pl-16'
      )}>
        <div className="p-4 sm:p-6 lg:p-8" data-main-content>
          {children}
        </div>
      </main>
    </div>
  );
}
