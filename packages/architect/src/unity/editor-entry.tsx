import '../polyfills/process';
import { useEffect, useRef, useState } from 'react';
import { CardEditor } from '../features/editor/CardEditor';
import { initializeModules } from '../lib/modules';
import { registerCustomWidgets } from '../lib/schemas/widgets';
import { useCardStore } from '../store/card-store';
import type { Card, CCv3Data } from '../lib/types';
import { useSettingsStore, THEMES } from '../store/settings-store';
import { localDB } from '../lib/db';
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

/** Architect's blank character (card-store createNewCard) without its immediate save. */
function blankCard(): Card {
  const now = new Date().toISOString();
  return {
    meta: { id: '', name: 'New Character', spec: 'v3', tags: [], createdAt: now, updatedAt: now },
    data: { spec: 'chara_card_v3', spec_version: '3.0', data: {
      name: 'New Character', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator: '',
      character_version: '1.0', tags: [], system_prompt: '', post_history_instructions: '', alternate_greetings: [], group_only_greetings: [],
    } } as CCv3Data,
  };
}

export function ArchitectEditor({ cardId, forkOf, onExit, onCreated }: {
  cardId: string; forkOf?: string | undefined; onExit?: (() => void) | undefined; onCreated?: ((cardId: string) => void) | undefined;
}) {
  const isDraft = cardId === '';
  const root = useRef<HTMLDivElement>(null);
  const currentCard = useCardStore((state) => state.currentCard);
  const isDirty = useCardStore((state) => state.isDirty);
  const isSaving = useCardStore((state) => state.isSaving);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<{ savedAt: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  useScopedTheme(root);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setDraft(null);
    useCardStore.getState().setCurrentCard(null);
    if (isDraft && forkOf) {
      // A fork draft is the original's current version without an id, so it is held in memory like a new card.
      void (async () => {
        await useCardStore.getState().loadCard(forkOf);
        if (!active) return;
        const loaded = useCardStore.getState().currentCard;
        if (!loaded || loaded.meta.id !== forkOf) { setError('The card to fork could not be opened.'); setLoading(false); return; }
        useCardStore.setState({ currentCard: { ...loaded, meta: { ...loaded.meta, id: '', forkOf } }, isDirty: false });
        setLoading(false);
      })();
      return () => { active = false; };
    }
    if (isDraft) {
      // Held in memory only: the store skips autosave and IndexedDB drafts for a card without an id.
      useCardStore.setState({ currentCard: blankCard(), isDirty: false });
      setLoading(false);
      return () => { active = false; };
    }
    void (async () => {
      await useCardStore.getState().loadCard(cardId);
      if (!active) return;
      const loaded = useCardStore.getState().currentCard;
      if (!loaded || loaded.meta.id !== cardId) { setError('This card could not be opened.'); setLoading(false); return; }
      const stored = await localDB.getDraft(cardId).catch(() => null);
      if (active && stored && stored.lastSaved > loaded.meta.updatedAt) setDraft({ savedAt: stored.lastSaved });
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
      const state = useCardStore.getState();
      if (state.autoSaveTimeout) clearTimeout(state.autoSaveTimeout);
    };
  }, [cardId, forkOf, isDraft]);

  async function save() {
    setError(null);
    try {
      const state = useCardStore.getState();
      if (state.isSaving) return; // a second Ctrl+S on a draft would otherwise create a second card
      if (state.autoSaveTimeout) clearTimeout(state.autoSaveTimeout);
      await state.saveCard();
      setSavedAt(new Date().toLocaleTimeString());
      const created = useCardStore.getState().currentCard?.meta.id;
      if (isDraft && created) onCreated?.(created);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Save failed');
    }
  }

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (useCardStore.getState().isDirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('keydown', keys); window.removeEventListener('beforeunload', leave); };
  }, []);

  async function restoreDraft() {
    const stored = await localDB.getDraft(cardId);
    if (stored?.card) {
      useCardStore.getState().setCurrentCard(stored.card);
      useCardStore.setState({ isDirty: true });
    }
    setDraft(null);
  }

  async function discardDraft() {
    await localDB.deleteDraft(cardId).catch(() => undefined);
    setDraft(null);
  }

  const status = isSaving ? 'Saving…' : isDraft ? (forkOf ? 'Fork — not in the library until you save' : 'New card — not in the library until you save') : isDirty ? 'Unsaved changes (autosaves after 30s idle)' : savedAt ? `Saved ${savedAt}` : 'All changes saved';

  return (
    <div ref={root} className="architect-root dark rounded-xl overflow-hidden border border-[var(--color-border)] flex flex-col" style={{ height: 'calc(100vh - 7rem)' }}>
      <div className="flex items-center gap-3 px-4 py-2 border-b" style={{ background: 'var(--color-surface)' }}>
        <span className="text-sm opacity-80 flex-1">{status}</span>
        <SettingsButton onClick={() => setShowSettings(true)} />
        {onExit && <button className="btn-secondary text-sm" onClick={onExit}>Done</button>}
        <button className="btn-primary text-sm" disabled={isSaving || (!isDirty && !isDraft)} onClick={() => { void save(); }} title="Save a new revision (Ctrl+S)">Save</button>
      </div>
      {draft && (
        <div className="flex items-center gap-3 px-4 py-2 text-sm bg-yellow-900/40 border-b">
          <span className="flex-1">You have unsaved changes from {new Date(draft.savedAt).toLocaleString()}.</span>
          <button className="btn-primary text-sm" onClick={() => { void restoreDraft(); }}>Restore</button>
          <button className="btn-secondary text-sm" onClick={() => { void discardDraft(); }}>Discard</button>
        </div>
      )}
      {error && <div className="px-4 py-2 text-sm bg-red-900/50 border-b" role="alert">{error}</div>}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <div className="flex-1 min-h-0">
        {loading ? <div className="p-12 text-center opacity-60">Loading card…</div> : currentCard && <CardEditor />}
      </div>
    </div>
  );
}
