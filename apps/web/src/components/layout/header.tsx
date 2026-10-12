'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { importFile } from '@/lib/unity';
import { libraryChanged, readSearch, useDebouncedText, writeSearch } from '@/lib/library-search';
import { cn } from '@/lib/utils/cn';

interface HeaderProps {
  onMenuClick: () => void;
}

const libraryPaths = new Set(['/', '/explore']);
const blankCard = () => JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: 'New character', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], group_only_greetings: [],
  tags: [], creator: '', character_version: '1.0', extensions: {},
} });

const iconButton = 'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-starlight/80 hover:bg-cosmic-teal/30 hover:text-starlight disabled:opacity-50';

export function Header({ onMenuClick }: HeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const onLibrary = libraryPaths.has(location.pathname);
  const current = onLibrary ? readSearch(new URLSearchParams(location.search)) : null;
  // On the library the box searches live and keeps the bar's filters; elsewhere it opens the library.
  const commit = useCallback((value: string) => {
    if (!onLibrary) return;
    const next = writeSearch({ ...readSearch(new URLSearchParams(window.location.search)), q: value }).toString();
    navigate(`${location.pathname}${next ? `?${next}` : ''}`, { replace: true });
  }, [onLibrary, navigate, location.pathname]);
  const [text, setText] = useDebouncedText(current?.q ?? '', commit);
  const [busy, setBusy] = useState<'import' | 'new' | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (onLibrary) commit(text);
    else navigate(text.trim() ? `/?${writeSearch({ ...readSearch(new URLSearchParams()), q: text })}` : '/');
  };

  async function importFiles(files: FileList) {
    setBusy('import'); setNotice(null);
    let imported = 0; const failed: string[] = [];
    for (const file of Array.from(files)) {
      try { await importFile(file); imported += 1; } catch { failed.push(file.name); }
    }
    setBusy(null); libraryChanged();
    setNotice({ text: `Imported ${imported} card${imported === 1 ? '' : 's'}.${failed.length ? ` Could not import: ${failed.join(', ')}` : ''}`, error: failed.length > 0 });
    setTimeout(() => setNotice(null), failed.length ? 10_000 : 4000);
  }
  async function createCard() {
    setBusy('new');
    try {
      const { card } = await importFile(new File([blankCard()], 'new-character.json', { type: 'application/json' }));
      libraryChanged();
      navigate(`/card/${card.id}/edit`);
    } catch (failure) {
      setNotice({ text: failure instanceof Error ? failure.message : 'Could not create a card', error: true });
    } finally { setBusy(null); }
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 nav-blur border-b border-nebula/20">
      <div className="flex items-center justify-between h-16 px-4">
        <div className="flex items-center gap-4">
          <button onClick={onMenuClick} className="p-2 rounded-lg hover:bg-cosmic-teal/30 transition-colors lg:hidden" aria-label="Menu">
            <svg className="w-6 h-6 text-starlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 cosmic-gradient rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">CU</span>
            </div>
            <span className="font-bold text-xl gradient-text hidden sm:inline">Character Unity</span>
          </Link>
        </div>

        <form onSubmit={submit} className="flex-1 max-w-xl mx-4" role="search">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-starlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="search" aria-label="Search the library" placeholder="Search characters..." value={text} onChange={(event) => setText(event.target.value)}
              className="w-full bg-cosmic-teal/30 border border-nebula/30 rounded-lg px-4 py-2 pl-10 text-starlight placeholder-starlight/50 focus:outline-none focus:border-nebula transition-colors" />
          </div>
        </form>

        <div className="flex items-center gap-1">
          <input ref={fileInput} type="file" multiple accept=".png,.json,.charx" className="hidden"
            onChange={(event) => { if (event.target.files?.length) void importFiles(event.target.files); event.target.value = ''; }} />
          <button type="button" className={iconButton} onClick={() => fileInput.current?.click()} disabled={!!busy} title="Import card files">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            <span className="hidden md:inline">{busy === 'import' ? 'Importing…' : 'Import'}</span>
          </button>
          <button type="button" className={iconButton} onClick={() => void createCard()} disabled={!!busy} title="Create a new card in the editor">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            <span className="hidden md:inline">{busy === 'new' ? 'Creating…' : 'New'}</span>
          </button>
          <Link href="/settings" className="p-2 rounded-lg hover:bg-cosmic-teal/30 transition-colors text-starlight/80" title="Settings" aria-label="Settings">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        </div>
      </div>
      {notice && (
        <div role={notice.error ? 'alert' : 'status'} className={cn('fixed bottom-4 right-4 z-[200] max-w-[calc(100vw-2rem)] rounded-lg px-4 py-3 text-sm text-white shadow-lg', notice.error ? 'bg-red-600' : 'bg-emerald-600')}>
          {notice.text}
        </div>
      )}
    </header>
  );
}
