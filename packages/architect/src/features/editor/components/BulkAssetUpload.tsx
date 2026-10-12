import { useState, useRef, useCallback } from 'react';
import { generateId } from '@card-architect/import-core';
import { api } from '../../../lib/api';
import { localDB, MAX_ASSET_SIZE, type StoredAsset } from '../../../lib/db';
import { getDeploymentConfig } from '../../../config/deployment';

const ASSET_TYPES = [
  { value: 'icon', label: 'Icon / Portrait' },
  { value: 'background', label: 'Background' },
  { value: 'emotion', label: 'Expression / Emotion' },
  { value: 'sound', label: 'Sound' },
  { value: 'workflow', label: 'Workflow (ComfyUI)' },
  { value: 'lorebook', label: 'Lorebook' },
  { value: 'custom', label: 'Custom' },
];

const DEFAULT_CONCURRENCY = 5;

interface FileEntry {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'success' | 'error';
  error?: string;
}

interface BulkAssetUploadProps {
  cardId: string;
  onComplete: () => void;
  onCancel: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!dataUrl.startsWith('data:image/')) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export function BulkAssetUpload({ cardId, onComplete, onCancel }: BulkAssetUploadProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [assetType, setAssetType] = useState('emotion');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);

  const config = getDeploymentConfig();
  const isLightMode = config.mode === 'light' || config.mode === 'static';

  const handleFileSelect = useCallback((fileList: FileList | null) => {
    if (!fileList) return;

    const newFiles: FileEntry[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.size > MAX_ASSET_SIZE) {
        continue;
      }
      newFiles.push({
        id: generateId(),
        file,
        status: 'pending',
      });
    }

    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      handleFileSelect(e.dataTransfer.files);
    },
    [handleFileSelect]
  );

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const clearAll = () => {
    setFiles([]);
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const uploadSingleFileLight = async (entry: FileEntry): Promise<void> => {
    const dataUrl = await readFileAsDataURL(entry.file);
    const ext = entry.file.name.split('.').pop()?.toLowerCase() || '';
    const dimensions = await getImageDimensions(dataUrl);

    const asset: StoredAsset = {
      id: generateId(),
      cardId,
      name: entry.file.name.replace(/\.[^/.]+$/, ''),
      type: assetType as StoredAsset['type'],
      ext,
      mimetype: entry.file.type,
      size: entry.file.size,
      width: dimensions?.width,
      height: dimensions?.height,
      data: dataUrl,
      isMain: false,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await localDB.saveAsset(asset);
  };

  const uploadSingleFileServer = async (entry: FileEntry): Promise<void> => {
    await api.uploadAsset(
      cardId,
      entry.file,
      assetType,
      entry.file.name.replace(/\.[^/.]+$/, ''),
      false,
      tags
    );
  };

  const startUpload = async () => {
    if (files.length === 0) return;

    setIsUploading(true);
    abortRef.current = false;

    const pendingFiles = files.filter((f) => f.status === 'pending');
    const queue = [...pendingFiles];
    const activeUploads: Promise<void>[] = [];

    const updateFileStatus = (id: string, status: FileEntry['status'], error?: string) => {
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status, error } : f)));
    };

    const processFile = async (entry: FileEntry) => {
      if (abortRef.current) return;

      updateFileStatus(entry.id, 'uploading');

      try {
        if (isLightMode) {
          await uploadSingleFileLight(entry);
        } else {
          await uploadSingleFileServer(entry);
        }
        updateFileStatus(entry.id, 'success');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Upload failed';
        updateFileStatus(entry.id, 'error', errorMessage);
      }
    };

    while (queue.length > 0 || activeUploads.length > 0) {
      if (abortRef.current) break;

      while (queue.length > 0 && activeUploads.length < concurrency) {
        const entry = queue.shift()!;
        const uploadPromise = processFile(entry).finally(() => {
          const idx = activeUploads.indexOf(uploadPromise);
          if (idx > -1) activeUploads.splice(idx, 1);
        });
        activeUploads.push(uploadPromise);
      }

      if (activeUploads.length > 0) {
        await Promise.race(activeUploads);
      }
    }

    setIsUploading(false);
  };

  const cancelUpload = () => {
    abortRef.current = true;
  };

  const retryFailed = () => {
    setFiles((prev) =>
      prev.map((f) => (f.status === 'error' ? { ...f, status: 'pending', error: undefined } : f))
    );
  };

  const successCount = files.filter((f) => f.status === 'success').length;
  const errorCount = files.filter((f) => f.status === 'error').length;
  const pendingCount = files.filter((f) => f.status === 'pending').length;
  const uploadingCount = files.filter((f) => f.status === 'uploading').length;
  const totalCount = files.length;
  const progress = totalCount > 0 ? ((successCount + errorCount) / totalCount) * 100 : 0;

  const allDone =
    isUploading === false && pendingCount === 0 && uploadingCount === 0 && totalCount > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-dark-surface rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="p-4 border-b border-dark-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">Bulk Asset Upload</h2>
          <button
            onClick={onCancel}
            className="p-1 hover:bg-dark-hover rounded"
            disabled={isUploading}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Asset Type</label>
              <select
                value={assetType}
                onChange={(e) => setAssetType(e.target.value)}
                className="input-field w-full"
                disabled={isUploading}
              >
                {ASSET_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Concurrency</label>
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="input-field w-full"
                disabled={isUploading}
              >
                <option value={3}>3 parallel</option>
                <option value={5}>5 parallel</option>
                <option value={10}>10 parallel</option>
                <option value={20}>20 parallel</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Tags (applied to all)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
                placeholder="Add tag..."
                className="input-field flex-1"
                disabled={isUploading}
              />
              <button onClick={addTag} className="btn-secondary px-3" disabled={isUploading}>
                Add
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-blue-600 text-white rounded-full"
                  >
                    {tag}
                    <button
                      onClick={() => removeTag(tag)}
                      className="hover:bg-blue-700 rounded-full w-4 h-4 flex items-center justify-center"
                      disabled={isUploading}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*,.json"
              multiple
              onChange={(e) => handleFileSelect(e.target.files)}
            />
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*,.json"
              multiple
              {...({ webkitdirectory: 'true', directory: 'true' } as any)}
              onChange={(e) => handleFileSelect(e.target.files)}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn-secondary flex-1"
              disabled={isUploading}
            >
              Select Files
            </button>
            <button
              onClick={() => folderInputRef.current?.click()}
              className="btn-secondary flex-1"
              disabled={isUploading}
            >
              Select Folder
            </button>
          </div>

          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              isUploading ? 'opacity-50' : 'hover:border-blue-500 cursor-pointer'
            } border-dark-border`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => !isUploading && fileInputRef.current?.click()}
          >
            <p className="text-dark-muted">
              {files.length === 0
                ? 'Drop files or folders here, or click to browse'
                : `${files.length} file(s) selected`}
            </p>
            <p className="text-xs text-dark-muted mt-1">Max file size: 50MB per file</p>
          </div>

          {files.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-dark-muted">
                  {successCount}/{totalCount} uploaded
                  {errorCount > 0 && ` (${errorCount} failed)`}
                </span>
                {!isUploading && (
                  <button onClick={clearAll} className="text-sm text-red-400 hover:text-red-300">
                    Clear All
                  </button>
                )}
              </div>

              {isUploading && (
                <div className="w-full bg-dark-bg rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}

              <div className="max-h-64 overflow-y-auto border border-dark-border rounded-lg divide-y divide-dark-border">
                {files.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 p-2 text-sm">
                    <div className="flex-shrink-0 w-5">
                      {entry.status === 'pending' && <span className="text-dark-muted">○</span>}
                      {entry.status === 'uploading' && (
                        <svg className="w-4 h-4 animate-spin text-blue-400" viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                          />
                        </svg>
                      )}
                      {entry.status === 'success' && (
                        <svg
                          className="w-4 h-4 text-green-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                      {entry.status === 'error' && (
                        <svg
                          className="w-4 h-4 text-red-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="flex-1 truncate" title={entry.file.name}>
                      {entry.file.name}
                    </span>
                    <span className="text-dark-muted text-xs">
                      {formatFileSize(entry.file.size)}
                    </span>
                    {entry.error && (
                      <span
                        className="text-red-400 text-xs truncate max-w-[150px]"
                        title={entry.error}
                      >
                        {entry.error}
                      </span>
                    )}
                    {entry.status === 'pending' && !isUploading && (
                      <button
                        onClick={() => removeFile(entry.id)}
                        className="text-dark-muted hover:text-red-400"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-dark-border flex items-center justify-between">
          <div>
            {errorCount > 0 && !isUploading && (
              <button onClick={retryFailed} className="btn-secondary">
                Retry Failed ({errorCount})
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {isUploading ? (
              <button onClick={cancelUpload} className="btn-danger">
                Cancel
              </button>
            ) : allDone ? (
              <button onClick={onComplete} className="btn-primary">
                Done
              </button>
            ) : (
              <>
                <button onClick={onCancel} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={startUpload} className="btn-primary" disabled={pendingCount === 0}>
                  Upload {pendingCount} File{pendingCount !== 1 ? 's' : ''}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
