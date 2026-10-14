import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AppShell } from '@/components/layout';
import { Modal } from '@/components/ui';
import { TagPicker } from '@/components/search/tag-picker';
import { useLibraryClient } from '@/lib/library-client';
import { useCardTags } from '@/lib/library-search';
import { createMetaTagClient, useMetaTags } from '@/lib/meta-tags';
import type { MetaTag, MetaTagCatalog } from '@/lib/meta-tags';
import { SessionError } from '@/lib/session';
import { validateMetaTagWrite } from '@character-unity/store/meta-tags';
import type { LibraryClient } from '@/lib/unity';

const button = 'rounded-md border border-starlight/15 px-3 py-2 text-sm text-starlight/80 hover:border-nebula/60 disabled:opacity-40';
const nameKey = (name: string) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const sameMember = (a: string, b: string) => nameKey(a) === nameKey(b);
const copyGroups = (groups: readonly MetaTag[]) => groups.map((group) => ({ ...group, members: [...group.members] }));
interface MetaTagDraft { baseline: MetaTagCatalog; groups: MetaTag[]; selected: string | null }
// Only the captured client's current workspace session owns this draft. Nothing
// is persisted, shared between clients or consulted as a global current draft.
const drafts = new WeakMap<LibraryClient, MetaTagDraft>();

function draftError(groups: readonly MetaTag[]): string | null {
  try { validateMetaTagWrite({ expectedVersion: 0, groups }); return null; }
  catch (failure) { return failure instanceof Error ? failure.message : 'The Meta-tag draft is invalid.'; }
}

/** A legacy alias file is an explicit draft import, not a storage or corpus migration. */
function legacyGroups(text: string): MetaTag[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object mapping each canonical name to an array of member tag strings.');
  const entries = Object.entries(parsed);
  if (!entries.length || entries.length > 100) throw new Error('The import must contain between 1 and 100 named groups.');
  const groups = entries.map(([name, members]) => {
    if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) throw new Error(`“${name}” must contain an array of tag strings.`);
    return { id: crypto.randomUUID(), name, members: members as string[] };
  });
  const error = draftError(groups);
  if (error) throw new Error(error);
  return groups;
}
function mergeGroups(current: readonly MetaTag[], imported: readonly MetaTag[]) {
  const next = copyGroups(current);
  for (const group of imported) {
    const index = next.findIndex((item) => nameKey(item.name) === nameKey(group.name));
    if (index >= 0) next[index] = { ...group, id: next[index]!.id, members: [...group.members] };
    else next.push({ ...group, members: [...group.members] });
  }
  return next;
}

export default function MetaTagsPage() {
  const library = useLibraryClient();
  return <AppShell><MetaTagsEditor key={library.scopeKey} /></AppShell>;
}

function MetaTagsEditor() {
  const library = useLibraryClient(), api = useMemo(() => createMetaTagClient(library), [library]);
  const saved = useMetaTags(), tags = useCardTags();
  const cached = drafts.get(library);
  const [baseline, setBaseline] = useState<MetaTagCatalog | null>(() => cached ? structuredClone(cached.baseline) : null);
  const [groups, setGroups] = useState<MetaTag[]>(() => cached ? copyGroups(cached.groups) : []);
  const [selected, setSelected] = useState<string | null>(() => cached?.selected ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false), [notice, setNotice] = useState<string | null>(
    () => cached ? 'Recovered your unsaved Meta-tag draft from this workspace session. Save is still required.' : null,
  );
  const [review, setReview] = useState<{ filename: string; groups: MetaTag[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const importGeneration = useRef(0), importPending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null), lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    if (!baseline && saved.catalog && !saved.loading && !saved.error) {
      setBaseline(structuredClone(saved.catalog)); setGroups(copyGroups(saved.catalog.groups));
      setSelected(saved.catalog.groups[0]?.id ?? null);
    }
  }, [baseline, saved.catalog, saved.loading, saved.error]);
  const dirty = !!baseline && JSON.stringify(groups) !== JSON.stringify(baseline.groups);
  const invalid = draftError(groups), active = groups.find((group) => group.id === selected);
  const mergedImport = review ? mergeGroups(groups, review.groups) : null;
  const importError = mergedImport ? draftError(mergedImport) : null;
  useLayoutEffect(() => {
    if (baseline && dirty) drafts.set(library, { baseline: structuredClone(baseline), groups: copyGroups(groups), selected });
    else drafts.delete(library);
  }, [library, baseline, groups, selected, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  function accept(catalog: MetaTagCatalog) {
    importGeneration.current++; importPending.current = false; setImporting(false);
    drafts.delete(library);
    setBaseline(structuredClone(catalog)); setGroups(copyGroups(catalog.groups));
    setSelected((id) => catalog.groups.some((group) => group.id === id) ? id : catalog.groups[0]?.id ?? null);
    setError(null); setConflict(false); setReview(null);
  }
  function edit(changes: Partial<Pick<MetaTag, 'name' | 'members'>>) {
    setGroups((current) => current.map((group) => group.id === selected ? { ...group, ...changes } : group)); setNotice(null);
  }
  async function save() {
    if (!baseline || busy || importPending.current || review || invalid || !dirty) return;
    const signal = lifetime.current!.signal;
    setBusy(true); setError(null); setNotice(null); setConflict(false);
    try {
      const catalog = await api.write({ expectedVersion: baseline.version, groups: copyGroups(groups) }, signal);
      if (!signal.aborted) { accept(catalog); setNotice('Meta-tags saved. Only explicitly selected group filters expand; card tags and files are unchanged.'); }
    } catch (failure) {
      if (!signal.aborted) {
        setConflict(failure instanceof SessionError && failure.code === 'HEAD_CONFLICT');
        setError(failure instanceof Error ? failure.message : 'Meta-tags could not be saved. Your draft is still here.');
      }
    } finally { if (!signal.aborted) setBusy(false); }
  }
  async function reload() {
    if (busy || importPending.current || (dirty && !window.confirm('Discard your unsaved Meta-tag changes and reload the saved catalog?'))) return;
    const signal = lifetime.current!.signal;
    setBusy(true); setError(null); setNotice(null);
    try { const catalog = await api.read(signal); if (!signal.aborted) accept(catalog); }
    catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : 'Meta-tags could not be reloaded. Your draft is still here.'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  async function reviewImport(file: File) {
    if (busy) return;
    const generation = ++importGeneration.current;
    const signal = lifetime.current!.signal;
    importPending.current = true; setImporting(true); setReview(null); setError(null); setNotice(null);
    try {
      if (file.size > 256 * 1024) throw new Error('Legacy Meta-tag JSON imports are limited to 256 KiB.');
      const text = await file.text();
      signal.throwIfAborted();
      if (generation !== importGeneration.current) return;
      const imported = legacyGroups(text);
      setReview({ filename: file.name, groups: imported });
    } catch (failure) { if (!signal.aborted && generation === importGeneration.current) setError(`${file.name}: ${failure instanceof Error ? failure.message : 'Import could not be reviewed.'}`); }
    finally { if (!signal.aborted && generation === importGeneration.current) { importPending.current = false; setImporting(false); } }
  }
  return <div className="mx-auto max-w-6xl space-y-5">
    <header className="space-y-2"><h1 className="text-xl font-semibold">Meta-tags</h1>
      <p className="max-w-3xl text-sm leading-relaxed text-starlight/60">Named tag groups for this workspace. A selected Meta-tag matches its name or any member tag. Raw tags remain literal: groups do not reverse-match, fuzzy-match, rewrite cards or copy files.</p>
      <p className="text-xs text-starlight/45">Choose groups in the Library or Archive filters. Changes stay in this draft until Save. Navigation keeps the draft in this current workspace session; reload, sign-out or switching workspace does not recover it.</p>
    </header>
    {!baseline ? <div className="rounded-xl border border-starlight/10 p-6">
      {saved.error ? <p role="alert" className="text-sm text-red-200">Meta-tags could not be read: {saved.error} <button type="button" onClick={saved.reload} className="ml-2 underline">Retry load</button></p>
        : <p role="status" className="text-sm text-starlight/60">Loading this workspace’s Meta-tags…</p>}
    </div> : <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || groups.length >= 100} className={button} onClick={() => {
          const group = { id: crypto.randomUUID(), name: '', members: [] };
          setGroups((current) => [...current, group]); setSelected(group.id); setNotice(null);
        }}>Create Meta-tag</button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (file) void reviewImport(file);
        }} />
        <button type="button" disabled={busy} className={button} onClick={() => fileInput.current?.click()}>Import legacy JSON…</button>
        <button type="button" disabled={busy || importing || !!review || !dirty || !!invalid} className="btn-primary rounded-md px-4 py-2 text-sm disabled:opacity-40" onClick={() => void save()}>{busy ? 'Working…' : 'Save Meta-tags'}</button>
        <button type="button" disabled={busy || importing || !dirty} className={button} onClick={() => {
          if (window.confirm('Discard your unsaved Meta-tag changes?')) { accept(baseline); setNotice('Draft changes discarded.'); }
        }}>Cancel changes</button>
        <button type="button" disabled={busy || importing} className={button} onClick={() => void reload()}>Reload saved catalog</button>
        <span aria-live="polite" className="ml-auto text-xs text-starlight/50">{dirty ? 'Unsaved changes' : `Saved version ${baseline.version}`} · {groups.length}/100 groups · {groups.reduce((count, group) => count + group.members.length, 0)}/1,000 members</span>
      </div>
      {importing && <div className="flex flex-wrap items-center gap-3 text-sm text-starlight/60"><p role="status">Reading legacy Meta-tag JSON… Save is paused until review finishes or is cancelled.</p>
        <button type="button" className="underline" onClick={() => { importGeneration.current++; importPending.current = false; setImporting(false); setNotice('Pending import cancelled. The draft is unchanged.'); }}>Cancel pending import</button></div>}
      {invalid && dirty && <p role="alert" className="text-xs text-amber-200">{invalid}</p>}
      {error && <div role="alert" className="space-y-2 rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-200"><p>{error}</p><p>Your draft has not been discarded.{conflict && ' Another save changed the catalog. Reload the latest catalog before saving again.'}</p>
        {conflict && <button type="button" disabled={busy} className="underline" onClick={() => void reload()}>Reload latest catalog</button>}</div>}
      {notice && <p role="status" className="text-sm text-nebula">{notice}</p>}
      {saved.error && <p role="alert" className="text-xs text-red-200">Catalog refresh failed: {saved.error} Your current draft is still here. <button type="button" onClick={saved.reload} className="underline">Retry refresh</button></p>}
      {saved.catalog && saved.catalog.version !== baseline.version && <p className="text-xs text-amber-200">A different saved catalog version is available. Reload saved catalog to review it; your draft will not be overwritten automatically.</p>}
      <fieldset disabled={busy} className="grid min-w-0 gap-4 lg:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]">
        <legend className="sr-only">Edit Meta-tags</legend>
        <nav aria-label="Workspace Meta-tags" className="max-h-[65dvh] space-y-1 overflow-y-auto rounded-xl border border-starlight/10 bg-deep-space/40 p-2">
          {!groups.length && <p className="p-3 text-sm text-starlight/50">No Meta-tags yet. Create one or review a legacy JSON import.</p>}
          {groups.map((group) => <button type="button" key={group.id} aria-pressed={selected === group.id} onClick={() => setSelected(group.id)}
            className={`block w-full rounded-lg px-3 py-2.5 text-left ${selected === group.id ? 'bg-nebula/15 text-nebula' : 'text-starlight/70 hover:bg-starlight/5'}`}>
            <span className="block break-words text-sm font-medium">{group.name || 'Untitled Meta-tag'}</span><span className="mt-1 block text-xs text-starlight/40">{group.members.length} member{group.members.length === 1 ? '' : 's'}</span>
          </button>)}
        </nav>
        {active ? <section aria-label="Selected Meta-tag" className="min-w-0 space-y-5 rounded-xl border border-starlight/10 p-4 sm:p-5">
          <label className="block space-y-1.5 text-sm"><span>Meta-tag name</span><input aria-label="Meta-tag name" value={active.name} maxLength={128} onChange={(event) => edit({ name: event.target.value })} className="w-full rounded-lg px-3 py-2" placeholder="For example, fantasy" /></label>
          <TagPicker key={active.id} label="Member tags" tone="include" value={active.members} options={tags} onChange={(members) => edit({ members })} compareTags={sameMember} placeholder="Choose or type a literal tag…" />
          <p className="text-xs leading-relaxed text-starlight/50">Use 1–100 members per group. Its own name also matches, even if not repeated above. Members may overlap with other groups; selecting one group does not select the other.</p>
          <div className="space-y-2"><h2 className="text-xs font-medium uppercase tracking-wide text-starlight/50">Matches any of these exact tags</h2><div className="flex flex-wrap gap-1.5">{[active.name, ...active.members].filter((tag, index, values) => tag.trim() && values.findIndex((value) => nameKey(value) === nameKey(tag)) === index).map((tag) =>
            <span key={tag} className="max-w-full break-words rounded-md border border-nebula/20 bg-nebula/10 px-2 py-1 text-xs text-starlight/80">{tag}</span>)}</div></div>
          <div className="flex flex-wrap items-center gap-3 border-t border-starlight/10 pt-4">
            <button type="button" className="rounded-md border border-red-400/30 px-3 py-2 text-sm text-red-200 hover:bg-red-400/5" onClick={() => {
              if (!window.confirm(`Delete Meta-tag “${active.name || 'Untitled'}” from this draft? Save to persist removal. Cards, literal tags and files are untouched.`)) return;
              const next = groups.filter((group) => group.id !== active.id); setGroups(next); setSelected(next[0]?.id ?? null); setNotice(null);
            }}>Delete Meta-tag</button><span className="text-xs text-starlight/45">Only this workspace’s named group is removed after Save.</span>
          </div>
        </section> : <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-starlight/10 p-6 text-sm text-starlight/45">Choose or create a Meta-tag to edit it.</div>}
      </fieldset>
      <div className="flex flex-wrap gap-4 text-sm"><Link to="/" className="text-nebula hover:underline">Back to Library</Link><Link to="/archive" className="text-nebula hover:underline">Search Archive</Link></div>
    </>}
    {review && <Modal isOpen onClose={() => setReview(null)} label="Review legacy Meta-tag import" size="lg"><div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">Review legacy Meta-tag import</h2><button type="button" aria-label="Close import review" onClick={() => setReview(null)}>×</button></div>
      <p className="break-words text-sm text-starlight/70">{review.filename} · {review.groups.length} groups. Matching canonical names replace their draft members and keep their IDs. Other groups are added; unlisted groups remain.</p>
      <p className="text-xs leading-relaxed text-starlight/50">This imports only canonical names and member lists. Legacy reverse/fuzzy alias behavior is not enabled. No files, card tags or live Archive settings are changed. Applying updates this draft only; Save is still required.</p>
      <ul className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-starlight/10 p-3">{review.groups.map((group) => {
        const existing = groups.find((item) => nameKey(item.name) === nameKey(group.name));
        return <li key={group.id}><details><summary className="cursor-pointer break-words text-sm"><span className="font-medium">{group.name}</span> · {existing ? 'Replace members' : 'Add group'} · {group.members.length} members</summary>
          <p className="mt-1 whitespace-pre-wrap break-words pl-3 text-xs leading-relaxed text-starlight/60">{group.members.join(', ') || 'No extra members; the canonical name itself matches.'}</p></details></li>;
      })}</ul>
      {importError && <p role="alert" className="text-sm text-red-200">{importError}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || importing || !!importError} className="btn-primary rounded-md px-4 py-2 text-sm disabled:opacity-40" onClick={() => {
        if (busy || importPending.current || !mergedImport || importError) return;
        setGroups(mergedImport); setSelected(review.groups.map((group) => mergedImport.find((item) => nameKey(item.name) === nameKey(group.name))?.id).find(Boolean) ?? null);
        setReview(null); setNotice('Legacy groups applied to the draft. Review and Save Meta-tags to persist them.');
      }}>Apply import to draft</button><button type="button" className={button} onClick={() => setReview(null)}>Cancel import</button></div>
    </div></Modal>}
  </div>;
}
