import type { ReactNode } from 'react';
import type { StatisticsCount, WorkspaceStatistics } from '@character-unity/store/statistics';

const number = (value: number) => value.toLocaleString('en-US');
function bytes(value: number) {
  if (value < 1024) return `${number(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${units[index]}`;
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border border-nebula/20 bg-deep-space/60 p-4">
    <h2 className="mb-4 text-sm font-semibold text-starlight">{title}</h2>{children}
  </section>;
}
function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="min-w-0 rounded-xl border border-nebula/20 bg-deep-space/60 p-4">
    <dt className="text-xs text-starlight/60">{title}</dt>
    <dd className="mt-1 break-words text-2xl font-semibold tabular-nums text-starlight">{value}</dd>
    <dd className="mt-1 text-xs leading-relaxed text-starlight/50">{detail}</dd>
  </div>;
}
function Rows({ values }: { values: readonly { label: string; value: string }[] }) {
  return <dl className="space-y-3 text-sm">{values.map((item) => <div key={item.label} className="flex items-start justify-between gap-4">
    <dt className="min-w-0 text-starlight/60">{item.label}</dt><dd className="shrink-0 text-right tabular-nums text-starlight">{item.value}</dd>
  </div>)}</dl>;
}
function Breakdown({ title, items }: { title: string; items: readonly StatisticsCount[] }) {
  return <Panel title={title}>{items.length ? <ol className="space-y-3 text-sm">{items.map((item) => <li key={item.label} className="flex items-start justify-between gap-3">
    <span className="min-w-0 break-words text-starlight/75">{item.label}</span><span className="shrink-0 tabular-nums text-starlight">{number(item.count)}</span>
  </li>)}</ol> : <p className="text-sm text-starlight/50">Nothing recorded yet.</p>}</Panel>;
}

/** Pure presentation also works in the browser-only profile; no hidden fetching. */
export function StatisticsReport({ statistics }: { statistics: WorkspaceStatistics }) {
  const { membership, content, storage, chat } = statistics;
  const coverage = (known: number) => `Known for ${number(known)} of ${number(membership.total)} library items`;
  const measured = (total: number, known: number) => known === 0 && membership.total > 0 ? 'Not measured' : number(total);
  return <div className="space-y-4">
    {membership.total === 0 && <p className="rounded-xl border border-nebula/20 bg-nebula/5 p-4 text-sm text-starlight/70">Your library is empty. Import a card or favorite an Archive card to add a reference.</p>}
    <dl aria-label="Library membership" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric title="Library items" value={number(membership.total)} detail="Owned cards and exact-version references" />
      <Metric title="Owned cards" value={number(membership.owned)} detail="Created, imported and saved derivatives" />
      <Metric title="Archive references" value={number(membership.archiveReferences)} detail="Originals and files remain in Archive" />
      <Metric title="Saved forks" value={number(membership.forks)} detail="Included in owned cards, not extra copies" />
    </dl>
    <dl aria-label="Known card content" className="grid gap-3 sm:grid-cols-3">
      <Metric title="Known greetings" value={measured(content.greetings.total, content.greetings.knownCards)}
        detail={`${coverage(content.greetings.knownCards)} · ${number(content.greetings.cards)} with greetings`} />
      <Metric title="Known lorebook entries" value={measured(content.lorebookEntries.total, content.lorebookEntries.knownCards)}
        detail={`${coverage(content.lorebookEntries.knownCards)} · ${number(content.lorebookEntries.cards)} with lorebooks`} />
      <Metric title="Measured tokens" value={measured(content.tokens.total, content.tokens.knownCards)} detail={`${coverage(content.tokens.knownCards)} · no counting triggered by this page`} />
    </dl>
    <div className="grid gap-4 md:grid-cols-3">
      <Panel title="Your library"><Rows values={[
        { label: 'Favorites', value: number(membership.favorites) },
        { label: 'Owned revision history', value: number(content.ownedRevisions) },
        { label: 'Cards with chat copies', value: number(membership.inChat) },
      ]} /><p className="mt-4 text-xs leading-relaxed text-starlight/50">Counts cover this workspace, not the full historical Archive.</p></Panel>
      <Panel title="Stored assets"><Rows values={[
        { label: `Local files (${number(storage.localAssets)})`, value: bytes(storage.localBytes) },
        { label: `Inherited records (${number(storage.inheritedAssets)})`, value: bytes(storage.inheritedBytes) },
        { label: `Staged records (${number(storage.stagedAssets)})`, value: bytes(storage.stagedBytes) },
      ]} /><p className="mt-4 text-xs leading-relaxed text-starlight/50">Retained asset records, not a disk scan; retired and untracked files are excluded. Shared local assets count once, including history. Inherited bytes remain in Archive. Staged sizes are declared, not verified disk usage; database overhead is not included.</p></Panel>
      <Panel title="Observed chat copies"><Rows values={[
        { label: 'Known copies', value: number(chat.copies) },
        { label: 'Matched to saved versions', value: number(chat.matched) },
        { label: 'Edited in chat apps', value: number(chat.edited) },
      ]} /><p className="mt-4 text-xs leading-relaxed text-starlight/50">Last observed state, not a live scan. Missing copies are excluded; matched copies may be behind the current head.</p></Panel>
    </div>
    <div><p className="mb-3 text-xs text-starlight/50">Top 12 by library-item count. Tags and creators use case-insensitive names; each tag counts once per item.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Breakdown title="Common tags" items={statistics.tags} /><Breakdown title="Creators" items={statistics.creators} />
        <Breakdown title="Original file formats" items={statistics.formats} /><Breakdown title="Sources" items={statistics.sources} />
      </div>
    </div>
  </div>;
}
