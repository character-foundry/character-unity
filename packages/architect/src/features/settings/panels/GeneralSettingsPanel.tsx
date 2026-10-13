import { useSettingsStore } from '../../../store/settings-store';

export function GeneralSettingsPanel() {
  const { features, setAssetsEnabled, setDiffEnabled } = useSettingsStore();
  return (
    <div className="space-y-6">
      <div><h3 className="settings-heading">Workspace preferences</h3>
        <p className="settings-description">Choose the tools and storage behavior for your workspace.</p></div>
      <section className="settings-section space-y-4">
        <h4 className="font-medium">Card workspace</h4>
        <label className="flex items-start justify-between gap-6">
          <span><span className="block text-sm font-medium">Assets tab</span><span className="block text-sm text-dark-muted mt-1">Manage portraits, images, and files attached to cards.</span></span>
          <input className="module-switch" role="switch" type="checkbox" checked={features.assetsEnabled} onChange={event => setAssetsEnabled(event.target.checked)} />
        </label>
        <label className="flex items-start justify-between gap-6">
          <span><span className="block text-sm font-medium">Diff tab</span><span className="block text-sm text-dark-muted mt-1">Compare versions and restore snapshots.</span></span>
          <input className="module-switch" role="switch" type="checkbox" checked={features.diffEnabled} onChange={event => setDiffEnabled(event.target.checked)} />
        </label>
      </section>
    </div>
  );
}
