import { Suspense, useRef, useEffect } from 'react';
import { useUIStore } from '../../store/ui-store';
import { useCardStore } from '../../store/card-store';
import { useEditorTabs, useAvailableTabIds } from '../../lib/registry/hooks';
import { EditorTabs } from './components/EditorTabs';
import type { TabContext } from '../../lib/registry/types';

interface CardEditorProps {
  context?: TabContext;
}

/**
 * Determine tab context from card spec
 */
function getTabContext(spec?: string): TabContext {
  if (spec === 'lorebook') return 'lorebook';
  if (spec === 'collection') return 'collection';
  return 'card';
}

/**
 * Loading spinner for lazy-loaded tab components
 */
function TabLoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

export function CardEditor({ context: contextProp }: CardEditorProps) {
  const activeTab = useUIStore((state) => state.activeTab);
  const setActiveTab = useUIStore((state) => state.setActiveTab);
  const currentCard = useCardStore((state) => state.currentCard);

  // Reset to edit tab when card changes
  const prevCardId = useRef<string | null>(null);
  useEffect(() => {
    if (currentCard?.meta?.id && currentCard.meta.id !== prevCardId.current) {
      setActiveTab('edit');
      prevCardId.current = currentCard.meta.id;
    }
  }, [currentCard?.meta?.id, setActiveTab]);

  // Auto-detect context from card spec if not provided
  const context = contextProp ?? getTabContext(currentCard?.meta?.spec);

  const tabs = useEditorTabs(context);
  const availableTabIds = useAvailableTabIds(context);
  // Find the effective active tab (fallback to first if current is not available)
  const effectiveActiveTab = availableTabIds.includes(activeTab)
    ? activeTab
    : availableTabIds[0] ?? 'edit';

  // Only the selected editor tool needs to be mounted.
  const currentTabDef = tabs.find((tab) => tab.id === effectiveActiveTab);

  return (
    <div className="h-full flex flex-col">
      <EditorTabs context={context} />

      <div className="flex-1 overflow-auto relative">
        {currentTabDef && (
          <Suspense fallback={<TabLoadingSpinner />}>
            <currentTabDef.component />
          </Suspense>
        )}
      </div>
    </div>
  );
}
