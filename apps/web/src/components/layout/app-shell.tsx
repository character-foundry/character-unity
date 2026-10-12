import type { ReactNode } from 'react';
import { Header } from './header';
import { cn } from '@/lib/utils/cn';

/** Top bar plus page body. `flush` pages (the library) lay out their own edges under the bar. */
export function AppShell({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="pt-12">
        <div className={cn(!flush && 'p-3 sm:p-4')} data-main-content>
          {children}
        </div>
      </main>
    </div>
  );
}
