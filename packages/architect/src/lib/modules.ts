/** Only modules implemented by the native editor are discoverable. */
import { useSettingsStore } from '../store/settings-store';
import { registry } from './registry';
import { isModuleEnabled } from './module-state';
import { registerCoreTabs } from '../features/editor/tabs';
import { registerCoreSettingsPanels } from '../features/settings/index';
import { MODULE_METADATA as focused } from '../modules/focused/metadata';
import { MODULE_METADATA as wizard } from '../modules/wwwyzzerdd/metadata';

const modules = [
  { metadata: focused, load: () => import('../modules/focused/index').then((module) => module.registerFocusedModule) },
  { metadata: wizard, load: () => import('../modules/wwwyzzerdd/index').then((module) => module.registerWwwyzzerddModule) },
];
const loaded = new Set<string>();
let initialized = false;

async function loadOptionalModules(): Promise<void> {
  await Promise.all(modules.filter(({ metadata }) => !loaded.has(metadata.id)).map(async ({ metadata, load }) => {
    // Editor settings are always registered; their card tabs honor the module flag.
    if (metadata.category !== 'editor' && !isModuleEnabled(metadata, useSettingsStore.getState().features)) return;
    const register = await load(); register(); loaded.add(metadata.id);
  }));
}

export async function initializeModules(): Promise<void> {
  if (initialized) return;
  for (const { metadata } of modules) registry.registerModule(metadata);
  registerCoreTabs(); registerCoreSettingsPanels();
  await loadOptionalModules();
  useSettingsStore.subscribe((state, previous) => {
    if (state.features !== previous.features) registry.invalidateAndNotify();
  });
  initialized = true;
}

export async function reloadModules(): Promise<void> { await loadOptionalModules(); }
