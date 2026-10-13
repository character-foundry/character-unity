import { FederationOverviewPanel } from './panels/FederationOverviewPanel';
import { registry } from '../../lib/registry';
import { GeneralSettingsPanel } from './panels/GeneralSettingsPanel';
import { ModulesSettingsPanel } from './panels/ModulesSettingsPanel';
import { EditorSettingsPanel } from './panels/EditorSettingsPanel';
import { ThemeSettingsPanel } from './panels/ThemeSettingsPanel';
import { ProvidersSettingsPanel } from './panels/ProvidersSettingsPanel';
import { PresetsSettingsPanel } from './panels/PresetsSettingsPanel';
import { TemplatesSettingsPanel } from './panels/TemplatesSettingsPanel';

export function registerCoreSettingsPanels() {
  registry.registerSettingsPanel({ id: 'federation-overview', label: 'Connections', group: 'federation', component: FederationOverviewPanel, order: 0 });
  registry.registerSettingsPanel({
    id: 'general',
    label: 'Preferences',
    group: 'general',
    component: GeneralSettingsPanel,
    order: 10,
    color: 'blue',
  });

  registry.registerSettingsPanel({
    id: 'modules',
    label: 'Overview',
    group: 'modules',
    component: ModulesSettingsPanel,
    order: 15,
    color: 'orange',
  });

  registry.registerSettingsPanel({
    id: 'editor',
    label: 'Standard',
    group: 'editors',
    component: EditorSettingsPanel,
    order: 25,
    color: 'blue',
  });

  registry.registerSettingsPanel({
    id: 'themes',
    label: 'Themes',
    component: ThemeSettingsPanel,
    order: 20,
    color: 'blue',
  });

  registry.registerSettingsPanel({
    id: 'providers',
    label: 'Providers',
    group: 'ai',
    component: ProvidersSettingsPanel,
    order: 40,
    color: 'blue',
  });

  registry.registerSettingsPanel({
    id: 'templates',
    label: 'Templates',
    component: TemplatesSettingsPanel,
    order: 60,
    color: 'blue',
  });

  registry.registerSettingsPanel({
    id: 'presets',
    label: 'LLM Presets',
    component: PresetsSettingsPanel,
    order: 70,
    color: 'blue',
  });

  // Add more core settings panels here as they are extracted
}
