'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Badge } from '@/components/ui';
import type { CharacterAsset, SavedAssetInfo } from '@/types/card';

interface AssetsSectionProps {
  assets?: CharacterAsset[]; // V3 card assets (may have data URIs)
  savedAssets?: SavedAssetInfo[] | null; // Extracted and saved assets from packages
}

interface NormalizedAsset {
  name: string;
  type: string;
  ext: string;
  path: string; // URL path to view/download (full size)
  thumbnailPath?: string; // URL path to thumbnail (for preview)
  isImage: boolean;
  isVideo: boolean;
}

function getAssetTypeLabel(type: string): string {
  switch (type) {
    case 'icon':
      return 'Icon';
    case 'background':
      return 'Background';
    case 'user_icon':
      return 'User Icon';
    case 'system_icon':
      return 'System Icon';
    case 'thumbnail':
      return 'Thumbnail';
    case 'custom':
      return 'Custom';
    default:
      return type;
  }
}

function getAssetTypeBadgeVariant(type: string): 'info' | 'success' | 'warning' | 'outline' {
  switch (type) {
    case 'icon':
    case 'thumbnail':
      return 'info';
    case 'background':
      return 'success';
    case 'user_icon':
      return 'warning';
    case 'system_icon':
    case 'custom':
    default:
      return 'outline';
  }
}

function isImageExtension(ext: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext.toLowerCase());
}

function isVideoExtension(ext: string): boolean {
  return ['mp4', 'webm'].includes(ext.toLowerCase());
}

function normalizeAssets(assets?: CharacterAsset[], savedAssets?: SavedAssetInfo[] | null): NormalizedAsset[] {
  const result: NormalizedAsset[] = [];

  // Prefer saved assets (extracted from packages)
  if (savedAssets && savedAssets.length > 0) {
    for (const asset of savedAssets) {
      result.push({
        name: asset.name,
        type: asset.type,
        ext: asset.ext,
        path: asset.path,
        thumbnailPath: asset.thumbnailPath,
        isImage: isImageExtension(asset.ext),
        isVideo: isVideoExtension(asset.ext),
      });
    }
    return result;
  }

  // Fall back to V3 card assets
  if (assets && assets.length > 0) {
    for (const asset of assets) {
      const ext = asset.ext || asset.uri.split('.').pop()?.split('?')[0] || '';
      result.push({
        name: asset.name || getAssetTypeLabel(asset.type),
        type: asset.type,
        ext: ext,
        path: asset.uri,
        isImage: asset.uri.startsWith('data:image/') || isImageExtension(ext),
        isVideo: asset.uri.startsWith('data:video/') || isVideoExtension(ext),
      });
    }
  }

  return result;
}

export function AssetsSection({ assets, savedAssets }: AssetsSectionProps) {
  const normalizedAssets = normalizeAssets(assets, savedAssets);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(
    normalizedAssets.length > 0 ? 0 : null
  );

  const selectedAsset = selectedIndex !== null ? normalizedAssets[selectedIndex] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold gradient-text flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
          Assets ({normalizedAssets.length})
        </h2>
      </div>

      {savedAssets && savedAssets.length > 0 && (
        <p className="text-sm text-starlight/60">
          These are sample preview assets from the uploaded package (up to 100 items or 100MB), not necessarily the full set.
        </p>
      )}

      {normalizedAssets.length === 0 ? (
        <p className="text-starlight/50 italic">No assets available.</p>
      ) : (
        <div className="flex gap-4 min-h-[600px]">
          {/* Left column - Asset list (1/4) */}
          <div className="w-1/4 min-w-[200px] bg-cosmic-teal/20 rounded-lg overflow-hidden">
            <div className="p-2 border-b border-nebula/20">
              <span className="text-xs text-starlight/50 uppercase font-semibold">Files</span>
            </div>
            <div className="overflow-y-auto max-h-[560px]">
              {normalizedAssets.map((asset, index) => {
                const isSelected = selectedIndex === index;

                return (
                  <button
                    key={index}
                    onClick={() => setSelectedIndex(index)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-nebula/10 transition-colors ${
                      isSelected
                        ? 'bg-nebula/30 text-starlight'
                        : 'text-starlight/70 hover:bg-cosmic-teal/30'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-starlight/40">#{index + 1}</span>
                      <span className="truncate flex-1">{asset.name}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <Badge variant={getAssetTypeBadgeVariant(asset.type)} size="sm">
                        {getAssetTypeLabel(asset.type)}
                      </Badge>
                      {asset.ext && (
                        <span className="text-xs text-starlight/40 uppercase">{asset.ext}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right column - Asset preview (3/4) */}
          <div className="flex-1 bg-cosmic-teal/20 rounded-lg p-4 overflow-y-auto max-h-[600px]">
            {selectedAsset ? (
              <div className="space-y-4">
                {/* Asset name */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-starlight/40 uppercase">Asset</span>
                    <p className="text-starlight/80 font-medium">{selectedAsset.name}</p>
                  </div>
                  <Badge variant={getAssetTypeBadgeVariant(selectedAsset.type)}>
                    {getAssetTypeLabel(selectedAsset.type)}
                  </Badge>
                </div>

                {/* Extension if available */}
                {selectedAsset.ext && (
                  <div>
                    <span className="text-xs text-starlight/40 uppercase">Format</span>
                    <p className="text-starlight/60 text-sm uppercase">{selectedAsset.ext}</p>
                  </div>
                )}

                {/* Preview */}
                <div>
                  <span className="text-xs text-starlight/40 uppercase block mb-2">Preview</span>
                  <div className="bg-deep-space/50 rounded-lg p-4 flex items-center justify-center min-h-[200px]">
                    {selectedAsset.isImage ? (
                      <div className="relative max-w-full max-h-[300px]">
                        {selectedAsset.path.startsWith('data:') ? (
                          <img
                            src={selectedAsset.path}
                            alt={selectedAsset.name}
                            className="max-w-full max-h-[300px] object-contain rounded"
                            loading="lazy"
                          />
                        ) : (
                          <Image
                            src={selectedAsset.thumbnailPath || selectedAsset.path}
                            alt={selectedAsset.name}
                            width={300}
                            height={300}
                            className="max-w-full max-h-[300px] object-contain rounded"
                            unoptimized
                          />
                        )}
                      </div>
                    ) : selectedAsset.isVideo ? (
                      <video
                        className="max-w-full max-h-[300px] rounded"
                        controls
                        preload="metadata"
                        src={selectedAsset.path}
                      />
                    ) : (
                      <div className="text-center text-starlight/50">
                        <svg className="w-16 h-16 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p>Non-image asset</p>
                        <p className="text-xs mt-1">
                          {selectedAsset.ext ? `Type: ${selectedAsset.ext.toUpperCase()}` : 'Unknown format'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            ) : (
              <p className="text-starlight/50 italic">Select an asset to view details.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
