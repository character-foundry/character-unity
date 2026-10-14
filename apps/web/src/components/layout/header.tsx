import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useLibraryState } from '@/lib/library-client';
import { useSession } from '@/lib/session-provider';
import { useSettings } from '@/lib/settings';
import { libraryChanged, readSearch, useDebouncedText, writeSearch } from '@/lib/library-search';
import { cn } from '@/lib/utils/cn';

const libraryPaths = new Set(['/', '/explore', '/archive']);
const pages = [{ name: 'Library', href: '/' }, { name: 'Archive', href: '/archive' }, { name: 'Content', href: '/content' }, { name: 'Meta-tags', href: '/meta-tags' }, { name: 'Stats', href: '/stats' }, { name: 'Sharing', href: '/sharing' }, { name: 'Remotes', href: '/remotes' }];

const action = 'flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-starlight/60 transition-colors hover:bg-cosmic-teal hover:text-starlight disabled:opacity-50';
// The global input rule is unlayered and outranks utilities; the field draws its own frame.
const bare = { border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none' } as const;

/** The top bar: home and pages, the library search (live on the library, Ctrl+K), Import, New and Settings. */
export function Header() {
  const { client, workspaces, selectWorkspace, createWorkspace } = useLibraryState();
  const account = useSession();
  const nav = client.connection.profile === 'browser' ? pages.filter((page) => !['/sharing', '/remotes'].includes(page.href)) : pages;
  const { settings, updateSettings } = useSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const onLibrary = libraryPaths.has(location.pathname);
  const current = onLibrary ? readSearch(new URLSearchParams(location.search)) : null;
  // Archive searches submit explicitly: typing must not issue embedding requests.
  const commit = useCallback((value: string) => {
    if (!onLibrary) return;
    const next = writeSearch({ ...readSearch(new URLSearchParams(window.location.search)), q: value }).toString();
    navigate(`${location.pathname}${next ? `?${next}` : ''}`, { replace: location.pathname !== '/archive' });
  }, [onLibrary, navigate, location.pathname]);
  const commitLive = useCallback((value: string) => { if (location.pathname !== '/archive') commit(value); }, [commit, location.pathname]);
  const [text, setText] = useDebouncedText(current?.q ?? '', commitLive);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popover, setPopover] = useState<'display' | 'account' | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean; existing: { id: string; name: string }[] } | null>(null);
  const mobileNav = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const popoverRoot = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null), accountButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const editorOpen = location.pathname === '/new' || /\/card\/[^/]+\/(?:edit|fork)$/.test(location.pathname);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!popover) return;
    const closeOutside = (event: PointerEvent) => { if (!popoverRoot.current?.contains(event.target as Node)) setPopover(null); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopover(null); (popover === 'display' ? displayButton : accountButton).current?.focus(); } };
    window.addEventListener('pointerdown', closeOutside); window.addEventListener('keydown', closeEscape);
    return () => { window.removeEventListener('pointerdown', closeOutside); window.removeEventListener('keydown', closeEscape); };
  }, [popover]);

  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus(); }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!mobileNav.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeEscape);
    };
  }, [menuOpen]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (onLibrary) commit(text);
    else navigate(text.trim() ? `/?${writeSearch({ ...readSearch(new URLSearchParams()), q: text })}` : '/');
  };

  async function importFiles(files: FileList) {
    setBusy(true); setNotice(null);
    let imported = 0; const failed: string[] = [], existing: { id: string; name: string }[] = [];
    for (const file of Array.from(files)) {
      if (!mounted.current || client.connection.signal.aborted) break;
      try {
        const result = await client.importFile(file);
        if (result.import.created && result.import.match !== 'archive') imported += 1;
        else existing.push({ id: result.card.id, name: file.name });
      } catch (failure) { failed.push(`${file.name}: ${failure instanceof Error ? failure.message : 'Import failed'}`); }
    }
    if (!mounted.current || client.connection.signal.aborted) return;
    setBusy(false); libraryChanged();
    setNotice({ text: `Imported ${imported} card${imported === 1 ? '' : 's'}.${existing.length ? ` Already have ${existing.length}; no duplicate stored.` : ''}${failed.length ? ` Could not import: ${failed.join(', ')}` : ''}`, error: failed.length > 0, existing });
    setTimeout(() => setNotice(null), failed.length || existing.length ? 10_000 : 4000);
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-12 items-center gap-2 border-b border-nebula/20 bg-deep-space px-3 sm:gap-3 sm:px-4">
      <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="Character Unity home">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-nebula text-[11px] font-bold text-white">CU</span>
        <span className="hidden text-sm font-semibold text-starlight lg:inline">Character Unity</span>
      </Link>

      <div ref={mobileNav} className="relative shrink-0 lg:hidden">
        <button type="button" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="mobile-navigation"
          onClick={() => setMenuOpen(!menuOpen)} className="grid h-8 w-7 place-items-center rounded-md text-starlight/70 hover:bg-cosmic-teal">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        {menuOpen && (
          <nav id="mobile-navigation" aria-label="Primary" className="absolute left-0 top-10 w-40 rounded-lg border border-nebula/30 bg-deep-space p-1 shadow-xl">
            {nav.map((item) => <Link key={item.href} to={item.href} onClick={() => setMenuOpen(false)}
              aria-current={(item.href === '/' ? location.pathname === '/' || location.pathname === '/explore' : location.pathname.startsWith(item.href)) ? 'page' : undefined}
              className="block rounded-md px-3 py-2 text-sm hover:bg-cosmic-teal"><span className="text-starlight">{item.name}</span></Link>)}
          </nav>
        )}
      </div>

      <nav aria-label="Primary" className="ml-2 hidden items-center gap-0.5 lg:flex">
        {nav.map((item) => {
          const active = item.href === '/' ? location.pathname === '/' || location.pathname === '/explore' : location.pathname.startsWith(item.href);
          return (
            // Colors sit on the inner span: the global link color is unlayered and outranks utilities on the link.
            <Link key={item.href} to={item.href} aria-current={active ? 'page' : undefined}
              className={cn('group shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium', active && 'bg-cosmic-teal')}>
              <span className={cn('transition-colors', active ? 'text-starlight' : 'text-starlight/50 group-hover:text-starlight')}>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <form onSubmit={submit} role="search" className="relative mx-auto flex h-8 min-w-0 w-full max-w-xl items-center rounded-md border border-nebula/25 bg-cosmic-teal/60 focus-within:border-nebula">
        <svg className="pointer-events-none absolute left-2.5 h-4 w-4 text-starlight/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input ref={searchInput} type="search" aria-label={location.pathname === '/archive' ? 'Search the Archive' : 'Search the library'} placeholder={location.pathname === '/archive' ? 'Search the Archive — press Enter' : 'Search characters, creators, tags…'} value={text}
          onChange={(event) => setText(event.target.value)} style={bare}
          className="h-full min-w-0 w-full pl-8 pr-2 text-[13px] text-starlight placeholder:text-starlight/40 sm:pr-14" />
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
        <div ref={popoverRoot} className="relative flex items-center">
        <button ref={displayButton} type="button" title="Display settings" aria-label="Display settings" aria-expanded={popover === 'display'} aria-controls="display-settings"
          onClick={() => setPopover(popover === 'display' ? null : 'display')} className="group grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-cosmic-teal">
          <svg className={cn('h-4 w-4 group-hover:text-starlight', location.pathname === '/settings' ? 'text-starlight' : 'text-starlight/60')} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button ref={accountButton} type="button" aria-label="Account and workspace" aria-expanded={popover === 'account'} aria-controls="account-workspace" title={`${client.connection.name} · ${workspaces.find((workspace) => workspace.id === client.workspaceId)?.name ?? 'Workspace'}`}
          onClick={() => setPopover(popover === 'account' ? null : 'account')} className="ml-1 grid h-7 w-7 place-items-center rounded-full border border-line bg-raised text-xs font-semibold text-ink">{client.connection.name.slice(0, 1).toUpperCase()}</button>
        {popover === 'display' && <section id="display-settings" aria-label="Display settings" className="absolute right-0 top-10 w-60 rounded-xl border border-line bg-surface p-4 shadow-xl">
          <p className="mb-3 text-xs font-medium text-muted">Display</p>
          <fieldset><legend className="mb-2 text-sm text-ink">Card size</legend><div role="radiogroup" aria-label="Card size" className="grid grid-cols-3 gap-1 rounded-lg bg-canvas p-1">
            {(['large', 'medium', 'small'] as const).map((size) => <label key={size} className={cn('density-option relative cursor-pointer rounded-md px-2 py-2 text-center text-xs capitalize', settings.cardSize === size ? 'bg-raised text-ink' : 'text-muted')}>
              <input type="radio" name="card-size" value={size} checked={settings.cardSize === size} onChange={() => updateSettings({ cardSize: size })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />{size[0].toUpperCase() + size.slice(1)}
            </label>)}
          </div></fieldset>
          <Link to="/settings" onClick={() => setPopover(null)} className="mt-4 block border-t border-line pt-3 text-sm">All settings</Link>
        </section>}
        {popover === 'account' && <section id="account-workspace" aria-label="Account and workspace" className="absolute right-0 top-10 w-72 max-w-[calc(100vw-1.5rem)] space-y-3 rounded-xl border border-line bg-surface p-4 shadow-xl">
          <div><p className="font-medium text-ink">{client.connection.name}</p><p className="text-xs text-muted">{client.connection.profile === 'hub' ? 'Hub account' : client.connection.profile === 'browser' ? 'Stored in this browser' : 'Local installation'}</p></div>
          <label className="block text-xs text-muted">Workspace<select aria-label="Workspace" value={client.workspaceId} disabled={editorOpen || busy || workspaceBusy} title={editorOpen ? 'Close the editor before switching workspace' : undefined}
            className="mt-1 w-full rounded-md p-2 text-sm" onChange={(event) => { selectWorkspace(event.target.value); navigate('/'); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          {editorOpen && <p className="text-xs text-muted">Close the editor before switching workspace. Your open draft stays with its original workspace.</p>}
          {!newWorkspace ? <button type="button" disabled={editorOpen || busy} className="text-sm text-nebula disabled:opacity-40" onClick={() => setNewWorkspace(true)}>New workspace</button> : <form className="space-y-2" onSubmit={(event) => {
            event.preventDefault(); setWorkspaceBusy(true); setAccountError(null);
            void createWorkspace(workspaceName.trim()).then(() => { if (mounted.current) navigate('/'); }).catch((failure: unknown) => { if (mounted.current) setAccountError(failure instanceof Error ? failure.message : 'Workspace could not be created'); }).finally(() => { if (mounted.current) setWorkspaceBusy(false); });
          }}><label className="block text-xs">Workspace name<input autoFocus required maxLength={120} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} className="mt-1 w-full rounded-md p-2 text-sm" /></label>
            <button type="submit" disabled={!workspaceName.trim() || workspaceBusy} className="btn-primary rounded-md px-3 py-2 text-xs disabled:opacity-40">Create workspace</button></form>}
          <button type="button" disabled={account.busy || workspaceBusy || busy} className="block w-full border-t border-line pt-3 text-left text-sm text-muted" onClick={() => { void account.logout().catch((failure: unknown) => { if (mounted.current) setAccountError(failure instanceof Error ? failure.message : 'Sign out failed'); }); }}>Sign out</button>
          {accountError && <p role="alert" className="text-xs text-red-300">{accountError}</p>}
        </section>}
        </div>
      </div>
      {notice && (
        <div role={notice.error ? 'alert' : 'status'} className={cn('fixed bottom-4 right-4 z-[200] max-w-[calc(100vw-2rem)] break-words rounded-lg px-4 py-3 text-sm text-white shadow-lg', notice.error ? 'bg-red-600' : 'bg-emerald-600')}>
          <p>{notice.text}</p>
          {notice.existing.length > 0 && <ul className="mt-2 space-y-1">{notice.existing.map((card, index) => <li key={`${card.id}:${index}`}><Link to={`/card/${encodeURIComponent(card.id)}`} className="underline"><span className="text-white">Open existing: {card.name}</span></Link></li>)}</ul>}
        </div>
      )}
    </header>
  );
}
