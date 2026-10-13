import { useUIStore } from '../../../store/ui-store';
import { useEditorTabs, useAvailableTabIds } from '../../../lib/registry/hooks';
import type { TabContext } from '../../../lib/registry/types';

interface EditorTabsProps {
  context?: TabContext;
}

export function EditorTabs({ context = 'card' }: EditorTabsProps) {
  const { activeTab, setActiveTab } = useUIStore();
  const tabs = useEditorTabs(context);
  const availableTabIds = useAvailableTabIds(context);

  // If current active tab is not available, fallback to first available
  const effectiveActiveTab = availableTabIds.includes(activeTab)
    ? activeTab
    : (availableTabIds[0] ?? 'edit');

  // Get color classes based on tab color
  const getColorClasses = (color?: string, isActive?: boolean) => {
    if (!isActive) return 'text-dark-muted hover:text-dark-text';

    switch (color) {
      case 'purple':
        return 'text-purple-400 border-b-2 border-purple-500 bg-dark-bg';
      case 'green':
        return 'text-green-400 border-b-2 border-green-500 bg-dark-bg';
      case 'orange':
        return 'text-orange-400 border-b-2 border-orange-500 bg-dark-bg';
      case 'red':
        return 'text-red-400 border-b-2 border-red-500 bg-dark-bg';
      default:
        return 'text-dark-text border-b-2 border-blue-500 bg-dark-bg';
    }
  };

  return (
    <div className="bg-dark-surface border-b border-dark-border">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 overflow-x-auto editor-tabs">
          {tabs.map((tab) => {
            const isActive = effectiveActiveTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`text-sm whitespace-nowrap font-medium transition-colors ${getColorClasses(tab.color, isActive)}`}
              >
                {tab.icon && <tab.icon className="w-4 h-4 mr-2 inline" />}
                {tab.label}
              </button>
            );
          })}
        </div>

      </div>
    </div>
  );
}
