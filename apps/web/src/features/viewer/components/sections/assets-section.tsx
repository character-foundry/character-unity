import { useState } from 'react';
import { Badge } from '@/components/ui';
import type { CharacterAsset, SavedAssetInfo } from '@/types/card';
import { ProtectedAudio, ProtectedDownload, ProtectedImage, ProtectedVideo } from '@/components/ui/protected-media';

interface AssetsSectionProps { assets: CharacterAsset[]; savedAssets: SavedAssetInfo[]; error: string | null }
const rasterImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export function AssetsSection({ assets, savedAssets, error }: AssetsSectionProps) {
  const [selectedBinding, setSelectedBinding] = useState<string | null>(savedAssets[0]?.binding ?? null);
  const selected = savedAssets.find((asset) => asset.binding === selectedBinding) ?? savedAssets[0];
  const stored = new Set(savedAssets.map((asset) => asset.binding));
  const unavailable = assets.map((asset, index) => ({ asset, binding: `declared/${index}` })).filter(({ binding }) => !stored.has(binding));
  return (
    <div className="space-y-4">
      <h2 className="gradient-text text-xl font-semibold">Assets ({savedAssets.length})</h2>
      <p className="text-sm text-starlight/60">Files stored with this saved revision. Original descriptor links are never fetched.</p>
      {error && <p role="alert" className="text-sm text-red-200">Preview metadata could not be loaded: {error} Downloads remain available.</p>}
      {unavailable.length > 0 && <div className="rounded-lg border border-amber-500/30 p-3 text-sm text-amber-200">{unavailable.map(({ asset, binding }) => <p key={binding}>{asset.name || binding}: no stored bytes in this revision.</p>)}</div>}
      {savedAssets.length === 0 ? <p className="italic text-starlight/50">No stored assets available.</p> :
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(180px,1fr)_3fr]">
          <ul className="max-h-[420px] min-w-0 overflow-y-auto rounded-lg bg-cosmic-teal/20">
            {savedAssets.map((asset) => <li key={asset.binding} aria-label={asset.name} className={`border-b border-nebula/10 p-3 ${selected?.binding === asset.binding ? 'bg-nebula/20' : ''}`}>
              <button type="button" onClick={() => setSelectedBinding(asset.binding)} aria-pressed={selected?.binding === asset.binding} className="w-full break-words text-left text-sm text-starlight/80">{asset.name}</button>
              <div className="mt-1 flex flex-wrap items-center gap-2"><Badge variant="outline" size="sm">{asset.type}</Badge><ProtectedDownload src={asset.path} filename={asset.name} className="text-xs text-nebula hover:underline">Download asset</ProtectedDownload></div>
            </li>)}
          </ul>
          {selected && <article aria-label={`Preview: ${selected.name}`} className="min-w-0 space-y-4 rounded-lg bg-cosmic-teal/20 p-4">
            <h3 className="break-words font-medium text-starlight/80">{selected.name}</h3>
            <p className="text-xs text-starlight/50">{selected.mediaType ?? 'Media type not yet loaded'}{selected.byteLength !== null ? ` · ${selected.byteLength.toLocaleString()} bytes` : ''}</p>
            <div className="flex min-h-40 items-center justify-center rounded-lg bg-deep-space/50 p-4">
              {selected.mediaType && rasterImages.has(selected.mediaType) ? <ProtectedImage key={selected.path} src={selected.path} alt={selected.name} loading="lazy" className="max-h-[400px] max-w-full rounded object-contain" /> :
                selected.mediaType?.startsWith('video/') ? <ProtectedVideo key={selected.path} src={selected.path} controls preload="none" className="max-h-[400px] max-w-full rounded" /> :
                  selected.mediaType?.startsWith('audio/') ? <ProtectedAudio key={selected.path} src={selected.path} controls preload="none" className="max-w-full" /> :
                    <p className="text-center text-sm text-starlight/50">{selected.mediaType === 'image/svg+xml' ? 'SVG files are download-only.' : 'No inline preview for this file. Download it to inspect its contents.'}</p>}
            </div>
          </article>}
        </div>}
    </div>
  );
}
