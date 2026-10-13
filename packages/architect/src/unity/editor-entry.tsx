import '../polyfills/process';
import { useCallback, useEffect, useState } from 'react';
import { CardEditor } from '../features/editor/CardEditor';
import { initializeModules } from '../lib/modules';
import { registerCustomWidgets } from '../lib/schemas/widgets';
import { useCardStore } from '../store/card-store';
import { useSettingsStore, THEMES } from '../store/settings-store';
import { useEditorSession } from './context';
import type { RecoveryDraft } from './recovery';
import { SettingsModal } from '../components/shared/SettingsModal';
import { SettingsButton } from '../components/shared/SettingsButton';

let prepared: Promise<void> | null = null;
/** Architect's bootstrap (main.tsx) without its App shell. */
export function prepareArchitect() {
  prepared ??= (async () => {
    registerCustomWidgets();
    await initializeModules();
  })();
  return prepared;
}

/** Theme variables live on the editor root, not <html>, so the CardsHub shell keeps its palette. */
function useScopedTheme(root: React.RefObject<HTMLDivElement | null>) {
  const themeId = useSettingsStore((state) => state.theme.themeId);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const theme = THEMES.find((item) => item.id === themeId) ?? THEMES[0]!;
    const colors: Record<string, string> = {
      '--color-bg': theme.colors.bg, '--color-surface': theme.colors.surface, '--color-border': theme.colors.border,
      '--color-text': theme.colors.text, '--color-muted': theme.colors.muted, '--color-accent': theme.colors.accent,
      '--color-accent-hover': theme.colors.accentHover,
    };
    for (const [name, value] of Object.entries(colors)) element.style.setProperty(name, value);
    element.classList.toggle('dark', theme.isDark);
  }, [root, themeId]);
}

export function ArchitectEditor({ cardId, forkOf, onExit, onCreated }: {
  cardId: string; forkOf?: string | undefined; onExit?: (() => void) | undefined; onCreated?: ((cardId: string) => void) | undefined;
}) {
  const isDraft = cardId === '';
  const session = useEditorSession();
  const root = session.root;
  const currentCard = useCardStore((state) => state.currentCard);
  const matchesSelection = Boolean(currentCard && (isDraft
    ? currentCard.meta.id === '' && currentCard.meta.forkOf === forkOf
    : currentCard.meta.id === cardId));
  const isDirty = useCardStore((state) => state.isDirty);
  const isSaving = useCardStore((state) => state.isSaving);
  const historyRestoring = useCardStore((state) => state.isRestoring);
  const [recovering, setRecovering] = useState(false);
  const isRestoring = historyRestoring || recovering;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selection = useCardStore((state) => state.selectionVersion);
  const [draft, setDraft] = useState<RecoveryDraft | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  useScopedTheme(root);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setDraft(null);
    const existing = session.cards.getState();
    const alreadySelected = !isDraft && existing.currentCard?.meta.id === cardId;
    if (!alreadySelected) { setShowSettings(false); setSavedAt(null); }
    void (async () => {
      await session.open({ cardId, forkOf });
      if (!active) return;
      const loaded = session.cards.getState().currentCard;
      if (!loaded || loaded.meta.id !== cardId) throw new Error('This card could not be opened.');
      const stored = cardId && !alreadySelected ? await session.recovery.load(cardId) : null;
      if (active && stored?.card.meta.id === cardId && (stored.lastSaved > loaded.meta.updatedAt || JSON.stringify(stored.card.data) !== JSON.stringify(loaded.data))) setDraft(stored);
      if (active) setLoading(false);
    })().catch((failure) => {
      if (!active) return;
      setError(failure instanceof Error ? failure.message : 'This card could not be opened.');
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [session, cardId, forkOf, isDraft]);

  const save = useCallback(async () => {
    if (loading || !matchesSelection || isRestoring) return;
    const selection = session.selection();
    setError(null);
    try {
      const state = session.cards.getState();
      if (state.isSaving) return; // a second Ctrl+S on a draft would otherwise create a second card
      if (state.autoSaveTimeout) clearTimeout(state.autoSaveTimeout);
      await session.save();
      if (session.signal.aborted || session.selection() !== selection) return;
      setSavedAt(new Date().toLocaleTimeString());
      const created = session.cards.getState().currentCard?.meta.id;
      if (created && created !== cardId) onCreated?.(created);
    } catch (failure) {
      if (!session.signal.aborted && session.selection() === selection) setError(failure instanceof Error ? failure.message : 'Save failed');
    }
  }, [session, cardId, onCreated, loading, matchesSelection, isRestoring]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && root.current?.contains(document.activeElement)) {
        event.preventDefault(); void save();
      }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (session.cards.getState().isDirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('keydown', keys); window.removeEventListener('beforeunload', leave); };
  }, [session, root, save]);

  async function restoreDraft() {
    if (!draft || isRestoring || isSaving) return;
    const snapshot = draft, selected = session.selection();
    setRecovering(true); setError(null);
    try {
      // Copy recovery into this owner before acknowledging the offered snapshot.
      // A crash between Restore and Save must still leave a recoverable draft.
      await session.recovery.save(cardId, snapshot.card, snapshot.baseRevisionId);
      await session.recovery.dismiss?.(snapshot);
      if (session.signal.aborted || selected !== session.selection()) return;
      session.cards.getState().setCurrentCard(structuredClone(snapshot.card));
      if (snapshot.baseRevisionId) session.api.pinRevision(cardId, snapshot.baseRevisionId);
      session.cards.setState({ isDirty: true });
      setDraft(null);
    } catch (failure) {
      if (!session.signal.aborted && selected === session.selection()) setError(failure instanceof Error ? failure.message : 'Recovery failed');
    } finally { if (!session.signal.aborted) setRecovering(false); }
  }

  async function discardDraft() {
    if (!draft || isRestoring || isSaving) return;
    const selected = session.selection();
    try {
      await session.recovery.dismiss?.(draft);
      if (!session.signal.aborted && selected === session.selection()) setDraft(null);
    } catch (failure) {
      if (!session.signal.aborted && selected === session.selection()) setError(failure instanceof Error ? failure.message : 'Recovery could not be dismissed');
    }
  }

  async function discardChanges() {
    if (!window.confirm('Discard unsaved changes to this card and its assets?')) return;
    setError(null);
    try {
      if (isDraft) {
        await session.discard();
        onExit?.();
      } else {
        await session.discard();
        setDraft(null);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not discard changes'); }
  }

  function exit() {
    if (session.cards.getState().isDirty && !window.confirm('Leave without saving changes to this card and its assets?')) return;
    session.cards.getState().setCurrentCard(null);
    onExit?.();
  }

  const status = loading ? 'Loading card…' : !matchesSelection ? 'Card unavailable' : isRestoring ? 'Restoring saved revision…' : isSaving ? 'Saving…' : isDraft ? (forkOf ? 'Fork — not in the library until you save' : 'New card — not in the library until you save') : isDirty ? (currentCard?.meta.archiveReference ? 'Unsaved changes — Save creates your fork' : 'Unsaved changes — Save creates a revision') : currentCard?.meta.archiveReference ? 'Archive original — changes stay local until you save a fork' : savedAt ? `Saved ${savedAt}` : 'All changes saved';

  return (
    <div ref={root} className="architect-root dark rounded-xl overflow-hidden border border-[var(--color-border)] flex flex-col" style={{ height: 'calc(100vh - 7rem)' }}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b" style={{ background: 'var(--color-surface)' }}>
        <span className="text-sm opacity-80 flex-1 min-w-40">{status}</span>
        <SettingsButton onClick={() => setShowSettings(true)} />
        {isDirty && matchesSelection && <button className="btn-secondary text-sm" disabled={loading || isSaving || isRestoring} onClick={() => { void discardChanges(); }}>Discard changes</button>}
        {onExit && <button className="btn-secondary text-sm" disabled={loading || isSaving || isRestoring} onClick={exit}>Done</button>}
        <button className="btn-primary text-sm" disabled={loading || !matchesSelection || isSaving || isRestoring || (!isDirty && !isDraft)} onClick={() => { void save(); }} title="Save a new revision (Ctrl+S)">Save</button>
      </div>
      {draft && (
        <div className="flex items-center gap-3 px-4 py-2 text-sm bg-yellow-900/40 border-b">
          <span className="flex-1">You have unsaved changes from {new Date(draft.lastSaved).toLocaleString()}.</span>
          <button className="btn-primary text-sm" disabled={isRestoring || isSaving} onClick={() => { void restoreDraft(); }}>Restore</button>
          <button className="btn-secondary text-sm" disabled={isRestoring || isSaving} onClick={() => { void discardDraft(); }}>Discard</button>
        </div>
      )}
      {error && <div className="px-4 py-2 text-sm bg-red-900/50 border-b" role="alert">{error}</div>}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <div className="flex-1 min-h-0" inert={isRestoring}>
        {loading ? <div className="p-12 text-center opacity-60">Loading card…</div> : matchesSelection && <CardEditor key={selection} />}
      </div>
    </div>
  );
}
