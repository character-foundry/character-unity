/**
 * Diff Panel - Saved Revision History and Comparison
 *
 * Provides immutable revision history and diff viewing with:
 * - CodeMirror 6 merge view for side-by-side comparison
 * - Per-entry lorebook diffing
 * - Support for character cards and standalone lorebooks
 */

import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { useCardStore } from '../../../store/card-store';
import type { UnityVersion } from '../../../lib/api';
import { useEditorSession } from '../../../unity/context';
import type { Card, DiffViewMode } from '../../../lib/types';
import {
  getLorebookFromData,
  computeLorebookDiff,
  cardHasLorebook,
  type LorebookDiff,
} from '../../../lib/diff-utils';

// Lazy load heavy components
const CodeMirrorMergeView = lazy(() =>
  import('../../../components/ui/CodeMirrorMergeView').then((m) => ({
    default: m.CodeMirrorMergeView,
  }))
);

const LorebookDiffView = lazy(() =>
  import('./LorebookDiffView').then((m) => ({ default: m.LorebookDiffView }))
);

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
    </div>
  );
}

// View mode selector component
function ViewModeSelector({
  mode,
  hasLorebook,
  lorebookDiff,
  onModeChange,
}: {
  mode: DiffViewMode;
  hasLorebook: boolean;
  lorebookDiff?: LorebookDiff;
  onModeChange: (mode: DiffViewMode) => void;
}) {
  const lorebookChanges = lorebookDiff
    ? lorebookDiff.entrySummary.added +
      lorebookDiff.entrySummary.removed +
      lorebookDiff.entrySummary.modified
    : 0;

  return (
    <div className="inline-flex rounded border border-dark-border overflow-hidden">
      <button
        onClick={() => onModeChange('split')}
        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
          mode === 'split'
            ? 'bg-blue-600 text-white'
            : 'bg-dark-card text-dark-muted hover:bg-dark-surface'
        }`}
      >
        Side-by-Side
      </button>
      <button
        onClick={() => onModeChange('unified')}
        className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-dark-border ${
          mode === 'unified'
            ? 'bg-blue-600 text-white'
            : 'bg-dark-card text-dark-muted hover:bg-dark-surface'
        }`}
      >
        Unified
      </button>
      {hasLorebook && (
        <button
          onClick={() => onModeChange('lorebook')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-dark-border flex items-center gap-1.5 ${
            mode === 'lorebook'
              ? 'bg-blue-600 text-white'
              : 'bg-dark-card text-dark-muted hover:bg-dark-surface'
          }`}
        >
          Lorebook
          {lorebookChanges > 0 && (
            <span
              className={`px-1.5 py-0.5 text-[10px] rounded-full ${
                mode === 'lorebook' ? 'bg-white/20' : 'bg-yellow-600 text-white'
              }`}
            >
              {lorebookChanges}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

export function DiffPanel() {
  const session = useEditorSession();
  const api = session.api;
  const currentCard = useCardStore((state) => state.currentCard);
  const selection = session.selection();
  const setCurrentCard = useCardStore((state) => state.setCurrentCard);
  const [versions, setVersions] = useState<UnityVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<(UnityVersion & { data: Card['data'] }) | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>('split');
  const [lorebookDiff, setLorebookDiff] = useState<LorebookDiff | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [loadingVersionId, setLoadingVersionId] = useState<string | null>(null);
  const request = useRef(0);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); request.current++; };
  }, []);

  // Check if current card has a lorebook
  const hasLorebook = currentCard ? cardHasLorebook(currentCard) : false;

  useEffect(() => {
    request.current++;
    setVersions([]);
    setSelectedVersion(null);
    setLoadingVersionId(null);
    setError(null);
    if (currentCard?.meta.id) {
      void loadVersions();
    }
  }, [selection, currentCard?.meta.id, currentCard?.meta.updatedAt]);

  // Compute lorebook diff when version is selected
  useEffect(() => {
    if (!selectedVersion || !currentCard) {
      setLorebookDiff(undefined);
      return;
    }

    const originalLorebook = getLorebookFromData(selectedVersion.data);
    const currentLorebook = getLorebookFromData(currentCard.data);

    if (originalLorebook || currentLorebook) {
      const diff = computeLorebookDiff(originalLorebook, currentLorebook);
      setLorebookDiff(diff);
    } else {
      setLorebookDiff(undefined);
    }
  }, [selectedVersion, currentCard]);

  const loadVersions = async () => {
    if (!currentCard?.meta.id) return;
    const generation = request.current;
    setIsLoading(true);
    const signal = AbortSignal.any([session.liveSignal(), lifetime.current.signal]);
    const result = await api.listVersions(currentCard.meta.id, { signal });
    if (request.current !== generation || signal.aborted || session.selection() !== selection) return;
    if (result.error) setError(result.error);
    else setVersions(result.data ?? []);
    setIsLoading(false);
  };

  const handleRestore = async (version: UnityVersion) => {
    if (!currentCard?.meta.id) return;
    if (session.cards.getState().isSaving || session.cards.getState().isRestoring) return;
    const warning = session.cards.getState().isDirty ? '\nUnsaved edits will be discarded.' : '';
    if (!confirm(`Restore Version ${version.version} as a new saved revision?${warning}`)) return;
    setIsRestoring(true);
    const selection = session.selection();
    const signal = AbortSignal.any([session.liveSignal(), lifetime.current.signal]);
    const live = () => session.selection() === selection && !signal.aborted;
    session.cards.setState({ isRestoring: true });
    setError(null);
    try {
      const result = await api.restoreVersion(currentCard.meta.id, version.id, { signal });
      if (result.error || !result.data) throw new Error(result.error ?? 'Restore failed');
      if (!live()) return;
      setCurrentCard(result.data);
      setSelectedVersion(null);
    } catch (err) {
      if (live()) setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      if (live()) setIsRestoring(false);
      if (session.selection() === selection && !session.signal.aborted) {
        session.cards.setState({ isRestoring: false });
      }
    }
  };

  const handleVersionClick = async (version: UnityVersion) => {
    const generation = ++request.current;
    const signal = AbortSignal.any([session.liveSignal(), lifetime.current.signal]);
    if (selectedVersion?.id === version.id) {
      setSelectedVersion(null);
      return;
    }
    if (version.data !== undefined) {
      setSelectedVersion({ ...version, data: version.data });
      return;
    }
    if (!currentCard?.meta.id) return;
    setLoadingVersionId(version.id);
    setError(null);
    try {
      const result = await api.getVersion(currentCard.meta.id, version.id, { signal });
      if (request.current !== generation || signal.aborted || session.selection() !== selection) return;
      if (result.error || !result.data) throw new Error(result.error ?? 'Failed to load revision');
      setSelectedVersion(result.data);
    } catch (err) {
      if (request.current === generation && !signal.aborted && session.selection() === selection) setError(err instanceof Error ? err.message : 'Failed to load revision');
    } finally {
      if (request.current === generation && !signal.aborted && session.selection() === selection) setLoadingVersionId(null);
    }
  };

  if (!currentCard) return null;

  // If a version is selected, show the diff
  if (selectedVersion) {
    const originalText = JSON.stringify(selectedVersion.data, null, 2);
    const revisedText = JSON.stringify(currentCard.data, null, 2);

    // Determine if we should show lorebook view
    const showLorebookView = viewMode === 'lorebook' && lorebookDiff;

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="p-4 bg-dark-surface border-b border-dark-border">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold">
              Comparing Version {selectedVersion.version} with Current
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => handleRestore(selectedVersion)}
                disabled={isRestoring}
                className="btn-primary"
              >
                Restore This Version
              </button>
              <button
                onClick={() => setSelectedVersion(null)}
                className="btn-secondary"
              >
                Back to Versions
              </button>
            </div>
          </div>

          {/* View mode selector */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-dark-muted">View:</span>
            <ViewModeSelector
              mode={viewMode}
              hasLorebook={hasLorebook || !!lorebookDiff}
              lorebookDiff={lorebookDiff}
              onModeChange={setViewMode}
            />
            {selectedVersion.message && (
              <span className="text-sm text-dark-muted ml-auto">
                "{selectedVersion.message}"
              </span>
            )}
          </div>
        </div>

        {error && <p role="alert" className="p-4 text-sm text-red-300">{error}</p>}

        {/* Diff content */}
        <div className="flex-1 overflow-auto p-4">
          <Suspense fallback={<LoadingSpinner />}>
            {showLorebookView && lorebookDiff ? (
              <LorebookDiffView
                lorebookDiff={lorebookDiff}
                originalData={selectedVersion.data}
                currentData={currentCard.data}
              />
            ) : (
              <CodeMirrorMergeView
                originalText={originalText}
                currentText={revisedText}
                language="json"
                collapseUnchanged={{ margin: 3, minSize: 4 }}
                height="calc(100vh - 250px)"
                originalLabel={`Version ${selectedVersion.version}`}
                currentLabel="Current"
              />
            )}
          </Suspense>
        </div>
      </div>
    );
  }

  // Version list view
  return (
    <div className="h-full flex flex-col">
      <div className="p-4 bg-dark-surface border-b border-dark-border flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Version History</h3>
          {hasLorebook && (
            <p className="text-xs text-dark-muted mt-1">
              This card has a lorebook - entry-level diffing available
            </p>
          )}
        </div>
        <p className="text-sm text-dark-muted">Each Save keeps a permanent revision.</p>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {error && <p role="alert" className="mb-4 text-sm text-red-300">{error}</p>}
        {isLoading ? <LoadingSpinner /> : versions.length === 0 ? (
          <div className="text-center text-dark-muted py-8">
            <p>No saved revisions yet</p>
            <p className="text-sm mt-2">
              Save the card to keep its first revision.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {versions.map((version) => (
              <div
                key={version.id}
                className="card flex justify-between items-center cursor-pointer hover:bg-dark-surface"
                onClick={() => handleVersionClick(version)}
              >
                <div>
                  <div className="font-medium flex items-center gap-2">
                    Version {version.version}
                    {version.message?.startsWith('[Auto]') && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-dark-muted/30 text-dark-muted rounded">
                        Auto
                      </span>
                    )}
                  </div>
                  {version.message && (
                    <div className="text-sm text-dark-muted">
                      {version.message.replace('[Auto] ', '')}
                    </div>
                  )}
                  <div className="text-xs text-dark-muted">
                    {new Date(version.createdAt).toLocaleString()}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleVersionClick(version);
                    }}
                    className="btn-secondary"
                  >
                    {loadingVersionId === version.id ? 'Loading...' : 'Compare'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRestore(version);
                    }}
                    className="btn-secondary"
                    disabled={isRestoring}
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
