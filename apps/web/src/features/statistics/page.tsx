import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceStatistics } from '@character-unity/store/statistics';
import { AppShell } from '@/components/layout';
import { useLibraryClient } from '@/lib/library-client';
import { createStatisticsClient, type StatisticsClient } from './client';
import { StatisticsReport } from './view';

export default function StatisticsPage() {
  const library = useLibraryClient();
  const client = useMemo(() => createStatisticsClient(library), [library]);
  return <AppShell><StatisticsContent key={client.scopeKey} client={client} /></AppShell>;
}
function StatisticsContent({ client }: { client: StatisticsClient }) {
  const [statistics, setStatistics] = useState<WorkspaceStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void client.read(controller.signal).then((result) => {
      if (!controller.signal.aborted) { setStatistics(result); setLoading(false); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Statistics could not be read.'); setLoading(false); }
    });
    return () => controller.abort();
  }, [client, attempt]);
  return <div className="mx-auto max-w-6xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-starlight">Collection stats</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-starlight/60">Your active character library at a glance; standalone JSON content is listed separately. Read-only summaries: no scrape, embedding job or chat scan runs when you open this page.</p></div>
      <button type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}
        className="rounded-lg border border-nebula/30 px-3 py-1.5 text-sm text-starlight/80 hover:bg-cosmic-teal/30 disabled:opacity-50">
        {error ? 'Retry statistics' : 'Refresh statistics'}
      </button>
    </div>
    {loading ? <p role="status" className="py-8 text-center text-sm text-starlight/60">Reading collection stats…</p>
      : error ? <div role="alert" className="rounded-xl border border-red-400/30 bg-red-400/5 p-4 text-sm text-red-200"><p>{error}</p><p className="mt-1 text-starlight/60">Statistics are unavailable; this is not an empty-library result.</p></div>
        : statistics ? <StatisticsReport statistics={statistics} /> : null}
  </div>;
}
