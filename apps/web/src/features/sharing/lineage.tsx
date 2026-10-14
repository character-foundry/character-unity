import type { PublishedLineage } from './client';

const short = (hash: string) => `${hash.slice(0, 12)}…`;

export function PublicationLineage({ value, busy, onMore, onRefresh }: {
  value: PublishedLineage; busy: boolean; onMore(): void; onRefresh(): void;
}) {
  return <section className="space-y-4" aria-label="Published lineage">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">Published lineage</h3><button type="button" disabled={busy} onClick={onRefresh}
        className="rounded-lg border border-nebula/20 px-3 py-1.5 text-xs disabled:opacity-50">Refresh lineage</button>
    </div>
    <p className="text-xs leading-relaxed text-starlight/50">Only visible publications are included. Unpublished or inaccessible parent hashes stay opaque; private revisions are not loaded.</p>
    <p className="break-all rounded-lg bg-cosmic-teal/50 p-3 text-xs text-starlight/60">Original file <code title={value.originalHash}>{short(value.originalHash)}</code></p>
    <ol className="space-y-3">{value.nodes.map((node) => <li key={node.publicationId} id={`publication-lineage-${node.publicationId}`}
      className="rounded-lg border border-nebula/15 p-3">
      <h4 className="text-sm font-medium">{node.title}</h4>
      <p className="mt-1 text-xs text-starlight/50">{node.operation === 'original' ? 'Untouched publication' : node.operation === 'fork' ? 'Fork revision' : 'Edit revision'}</p>
      <dl className="mt-2 space-y-1 break-all text-xs text-starlight/60"><div><dt className="inline">Content </dt><dd className="inline"><code title={node.content.hash}>{short(node.content.hash)}</code></dd></div>
        {node.revisionHash && <div><dt className="inline">Revision </dt><dd className="inline"><code title={node.revisionHash}>{short(node.revisionHash)}</code></dd></div>}</dl>
      <ul className="mt-2 space-y-1 text-xs text-starlight/50">
        {!node.parents.length && !node.forkedFromPublicationId && <li>From original file</li>}
        {node.forkedFromPublicationId && <li>Forked from {(() => {
          const parent = value.nodes.find((item) => item.publicationId === node.forkedFromPublicationId);
          return parent ? <a href={`#publication-lineage-${parent.publicationId}`}>{parent.title}</a>
            : <span>publication <code title={node.forkedFromPublicationId}>{short(node.forkedFromPublicationId)}</code> (not in this view)</span>;
        })()}</li>}
        {node.parents.map((parent) => <li key={parent.revisionHash}>Parent revision {(() => {
          const matches = value.nodes.filter((item) => item.revisionHash === parent.revisionHash);
          return matches.length ? matches.map((item, index) => <span key={item.publicationId}>{index ? ', ' : ''}<a href={`#publication-lineage-${item.publicationId}`}>{item.title}</a></span>)
            : <span><code title={parent.revisionHash}>{short(parent.revisionHash)}</code> (not in this view)</span>;
        })()}</li>)}
      </ul>
    </li>)}</ol>
    {value.nextAfter ? <button type="button" disabled={busy} onClick={onMore} className="rounded-lg border border-nebula/20 px-3 py-2 text-sm disabled:opacity-50">More lineage</button>
      : <p className="text-xs text-starlight/40">End of visible publications. Refresh to check for changes.</p>}
  </section>;
}
