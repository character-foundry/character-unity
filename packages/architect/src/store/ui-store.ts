import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useEditorSession } from '../unity/context';

export type CoreEditorTab = 'edit' | 'preview' | 'diff' | 'focused' | 'assets' | 'wwwyzzerdd';
export type EditorTab = string;
export interface UIStore {
  activeTab: EditorTab;
  showAdvanced: boolean;
  setActiveTab(tab: EditorTab): void;
  setShowAdvanced(show: boolean): void;
}

export function createUIStore(): StoreApi<UIStore> {
  return createStore<UIStore>((set) => ({
    activeTab: 'edit', showAdvanced: false,
    setActiveTab: (activeTab) => set({ activeTab }),
    setShowAdvanced: (showAdvanced) => set({ showAdvanced }),
  }));
}

export function useUIStore(): UIStore;
export function useUIStore<T>(selector: (state: UIStore) => T): T;
export function useUIStore<T>(selector?: (state: UIStore) => T): T | UIStore {
  return useStore(useEditorSession().ui, (state): T | UIStore => selector ? selector(state) : state);
}
