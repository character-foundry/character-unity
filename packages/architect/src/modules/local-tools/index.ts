import { lazy } from 'react';
import { registry } from '../../lib/registry';
import { useSettingsStore } from '../../store/settings-store';

const LocalToolsTab = lazy(() => import('../../features/local-tools/LocalToolsTab').then((value) => ({ default: value.LocalToolsTab })));
const LocalToolsSettings = lazy(() => import('../../features/local-tools/LocalToolsTab').then((value) => ({ default: value.LocalToolsSettings })));
export function registerLocalToolsModule() {
  registry.registerTab({ id: 'local-tools', label: 'Local tools', component: LocalToolsTab, contexts: ['card'], order: 80,
    condition: () => useSettingsStore.getState().features.localToolsEnabled ?? false });
  registry.registerSettingsPanel({ id: 'local-tools', label: 'Local tools', component: LocalToolsSettings,
    group: 'editors', moduleId: 'local-tools', order: 45 });
}
