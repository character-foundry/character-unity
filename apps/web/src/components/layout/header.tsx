'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { importFile } from '@/lib/unity';
import { libraryChanged, readSearch, useDebouncedText, writeSearch } from '@/lib/library-search';
import { cn } from '@/lib/utils/cn';

const libraryPaths = new Set(['/', '/explore']);
// Stats, presets and lorebooks join this list as they are ported.
const nav = [{ name: 'Library', href: '/' }];

const action = 'flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-starlight/60 transition-colors hover:bg-cosmic-teal hover:text-starlight disabled:opacity-50';
// The global input rule is unlayered and outranks utilities; the field draws its own frame.
const bare = { border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none' } as const;

/** The top bar: home and pages, the library search (live on the library, Ctrl+K), Import, New and Settings. */
export function Header() {
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus(); }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (onLibrary) commit(text);
    else navigate(text.trim() ? `/?${writeSearch({ ...readSearch(new URLSearchParams()), q: text })}` : '/');
  };

  async function importFiles(files: FileList) {
    setBusy(true); setNotice(null);
    let imported = 0; const failed: string[] = [];
    for (const file of Array.from(files)) {
      try { await importFile(file); imported += 1; } catch { failed.push(file.name); }
    }
    setBusy(false); libraryChanged();
    setNotice({ text: `Imported ${imported} card${imported === 1 ? '' : 's'}.${failed.length ? ` Could not import: ${failed.join(', ')}` : ''}`, error: failed.length > 0 });
    setTimeout(() => setNotice(null), failed.length ? 10_000 : 4000);
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-12 items-center gap-3 border-b border-nebula/20 bg-deep-space px-3 sm:px-4">
      <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Character Unity home">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-nebula text-[11px] font-bold text-white">CU</span>
        <span className="hidden text-sm font-semibold text-starlight lg:inline">Character Unity</span>
      </Link>

      <nav aria-label="Primary" className="ml-2 hidden items-center gap-0.5 md:flex">
        {nav.map((item) => {
          const active = item.href === '/' ? onLibrary : location.pathname.startsWith(item.href);
          return (
            // Colors sit on the inner span: the global link color is unlayered and outranks utilities on the link.
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
              className={cn('group rounded-md px-2.5 py-1 text-[13px] font-medium', active && 'bg-cosmic-teal')}>
              <span className={cn('transition-colors', active ? 'text-starlight' : 'text-starlight/50 group-hover:text-starlight')}>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <form onSubmit={submit} role="search" className="relative mx-auto flex h-8 w-full max-w-xl items-center rounded-md border border-nebula/25 bg-cosmic-teal/60 focus-within:border-nebula">
        <svg className="pointer-events-none absolute left-2.5 h-4 w-4 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input ref={searchInput} type="search" aria-label="Search the library" placeholder="Search characters, creators, tags…" value={text}
          onChange={(event) => setText(event.target.value)} style={bare}
          className="h-full w-full pl-8 pr-14 text-[13px] text-starlight placeholder:text-starlight/40" />
        <kbd className="pointer-events-none absolute right-2 hidden rounded border border-nebula/25 px-1.5 text-[10px] text-starlight/40 sm:block">Ctrl K</kbd>
      </form>

      <div className="flex shrink-0 items-center gap-1">
        <input ref={fileInput} type="file" multiple accept=".png,.json,.charx" className="hidden"
          onChange={(event) => { if (event.target.files?.length) void importFiles(event.target.files); event.target.value = ''; }} />
        <button type="button" className={action} onClick={() => fileInput.current?.click()} disabled={busy} title="Import card files">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
          <span className="hidden sm:inline">{busy ? 'Importing…' : 'Import'}</span>
        </button>
        <button type="button" onClick={() => navigate('/new')} disabled={busy} title="Create a new card in the editor"
          className="flex h-8 items-center gap-1.5 rounded-md bg-nebula px-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          <span className="hidden sm:inline">New</span>
        </button>
        <Link href="/settings" title="Settings" aria-label="Settings" className="group grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-cosmic-teal">
          <svg className={cn('h-4 w-4 group-hover:text-starlight', location.pathname === '/settings' ? 'text-starlight' : 'text-starlight/60')} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </Link>
      </div>
      {notice && (
        <div role={notice.error ? 'alert' : 'status'} className={cn('fixed bottom-4 right-4 z-[200] max-w-[calc(100vw-2rem)] rounded-lg px-4 py-3 text-sm text-white shadow-lg', notice.error ? 'bg-red-600' : 'bg-emerald-600')}>
          {notice.text}
        </div>
      )}
    </header>
  );
}
