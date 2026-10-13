/**
 * Background Upload Widget
 *
 * Image upload widget with preview for background images.
 */

import { useState } from 'react';
import type { FieldWidgetProps } from '@character-foundry/character-foundry/app-framework';

export function BackgroundUpload({
  value,
  onChange,
  name,
  hint,
}: FieldWidgetProps<string>) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setError('Select a PNG, JPEG, WebP, or GIF image'); return;
    }
    if (file.size > 2 * 1024 * 1024) { setError('Background images must be smaller than 2 MB'); return; }
    setUploading(true); setError(null);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read image'));
        reader.onerror = () => reject(new Error('Unable to read image'));
        reader.readAsDataURL(file);
      });
      onChange(data);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save background'); }
    finally { setUploading(false); event.target.value = ''; }
  };
  const handleRemove = () => onChange('');

  return (
    <div className={hint?.className} data-field={name}>
      {hint?.label && (
        <label className="block text-sm font-medium mb-2">{hint.label}</label>
      )}
      {hint?.helperText && (
        <p className="text-sm text-dark-muted mb-3">{hint.helperText}</p>
      )}

      <div className="space-y-3">
        {/* Preview */}
        {value && (
          <div className="relative">
            <img
              src={value}
              alt="Background preview"
              className="w-full h-32 object-cover rounded-lg border border-dark-border"
            />
            <button
              type="button"
              onClick={handleRemove}
              className="absolute top-2 right-2 px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
            >
              Remove
            </button>
          </div>
        )}

        {/* Upload input */}
        <div>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleFileChange}
            disabled={uploading}
            className="w-full text-sm text-dark-text file:mr-3 file:rounded file:border-0 file:px-3 file:py-2 file:bg-blue-600 file:text-white file:cursor-pointer disabled:opacity-50"
          />
        </div>

        {/* Status */}
        {uploading && (
          <p className="text-sm text-blue-400">Uploading...</p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
