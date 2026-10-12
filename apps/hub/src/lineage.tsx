import type { LineagePage } from './api.js';

/** A graph of visible publications and their explicit public hash references. */
export function LineageGraph({ graph, busy, onMore, onRefresh, onClose }: {
  graph: LineagePage; busy: boolean; onMore(): void; onRefresh(): void; onClose(): void;
}) {
  const short = (hash: string) => `${hash.slice(0, 12)}…`;
  return <section className="hub-panel hub-lineage" aria-label="Published lineage">
    <div className="hub-row"><h2>Published lineage</h2><button disabled={busy} onClick={onRefresh}>Refresh lineage</button><button disabled={busy} onClick={onClose}>Close lineage</button></div>
    <p>Published revisions and forks that share this original. Only publications you can read are shown.</p>
    <div className="hub-lineage-root"><strong>Original file</strong><code title={graph.originalHash}>{short(graph.originalHash)}</code></div>
    <ol className="hub-lineage-nodes">{graph.nodes.map((node) => <li key={node.publicationId} id={`lineage-${node.publicationId}`} className={node.publicationId === graph.anchorId ? 'hub-lineage-selected' : ''}>
      <h3>{node.title}</h3><p>{node.operation === 'original' ? 'Untouched publication' : node.operation === 'fork' ? 'Fork revision' : 'Edit revision'}</p>
      <dl><div><dt>Content</dt><dd><code title={node.content.hash}>{short(node.content.hash)}</code></dd></div>
        {node.revisionHash && <div><dt>Revision</dt><dd><code title={node.revisionHash}>{short(node.revisionHash)}</code></dd></div>}
      </dl>
      <ul className="hub-lineage-edges">
        {!node.parents.length && !node.forkedFromPublicationId && <li>From original file</li>}
        {node.forkedFromPublicationId && <li>Forked from {(() => {
          const source = graph.nodes.find((candidate) => candidate.publicationId === node.forkedFromPublicationId);
          return source ? <a href={`#lineage-${source.publicationId}`}>{source.title}</a> : <span>publication <code title={node.forkedFromPublicationId}>{short(node.forkedFromPublicationId)}</code> (not in this view)</span>;
        })()}</li>}
        {node.parents.map((parent) => {
          const matches = graph.nodes.filter((candidate) => candidate.revisionHash === parent.revisionHash);
          return <li key={parent.revisionHash}>Parent revision {matches.length
            ? matches.map((source, index) => <span key={source.publicationId}>{index ? ', ' : ''}<a href={`#lineage-${source.publicationId}`}>{source.title}</a></span>)
            : <span><code title={parent.revisionHash}>{short(parent.revisionHash)}</code> (not in this view)</span>}</li>;
        })}
      </ul>
    </li>)}</ol>
    {graph.nextAfter ? <button disabled={busy} onClick={onMore}>Load more lineage</button> : <p className="hub-muted">End of visible publications. Refresh to check for changes.</p>}
    <p className="hub-muted">A parent not shown here may be unpublished, unavailable to you, on another hub, or on a page not loaded yet. Hash references come from public card metadata; private revision details are not disclosed.</p>
  </section>;
}
