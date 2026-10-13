import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  metadata: vi.fn(), coreTabs: vi.fn(), coreSettings: vi.fn(),
  focused: vi.fn(), wizard: vi.fn(), subscribe: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../store/settings-store', () => ({ useSettingsStore: {
  getState: () => ({ features: { focusedEnabled: true, wwwyzzerddEnabled: true } }),
  subscribe: calls.subscribe,
} }));
vi.mock('./registry', () => ({ registry: { registerModule: calls.metadata, invalidateAndNotify: calls.invalidate } }));
vi.mock('../features/editor/tabs', () => ({ registerCoreTabs: calls.coreTabs }));
vi.mock('../features/settings/index', () => ({ registerCoreSettingsPanels: calls.coreSettings }));
vi.mock('../modules/focused/index', () => ({ registerFocusedModule: calls.focused }));
vi.mock('../modules/wwwyzzerdd/index', () => ({ registerWwwyzzerddModule: calls.wizard }));

describe('shared immutable editor module bootstrap', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('shares initialization and optional loads across concurrent editor hosts', async () => {
    const { initializeModules, reloadModules } = await import('./modules');
    await Promise.all([initializeModules(), initializeModules(), reloadModules()]);
    await initializeModules();
    await reloadModules();
    expect(calls.metadata).toHaveBeenCalledTimes(2);
    expect(calls.coreTabs).toHaveBeenCalledTimes(1);
    expect(calls.coreSettings).toHaveBeenCalledTimes(1);
    expect(calls.focused).toHaveBeenCalledTimes(1);
    expect(calls.wizard).toHaveBeenCalledTimes(1);
    expect(calls.subscribe).toHaveBeenCalledTimes(1);
  });

  it('retries a failed optional load without registering the core twice', async () => {
    calls.focused.mockImplementationOnce(() => { throw new Error('Module initialization failed'); });
    const { initializeModules } = await import('./modules');
    await expect(initializeModules()).rejects.toThrow('Module initialization failed');
    await initializeModules();
    expect(calls.coreTabs).toHaveBeenCalledTimes(1);
    expect(calls.coreSettings).toHaveBeenCalledTimes(1);
    expect(calls.focused).toHaveBeenCalledTimes(2);
    expect(calls.wizard).toHaveBeenCalledTimes(1);
    expect(calls.subscribe).toHaveBeenCalledTimes(1);
  });
});
