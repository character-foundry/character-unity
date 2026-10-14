import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { formatRelative } from '@/lib/utils/format';
import { libraryChanged } from '@/lib/library-search';
import { useArchiveApi } from '@/lib/archive';
import type { ArchiveRun, ArchiveSource, SettingValue } from '@/lib/archive';

const field = 'w-full rounded-md border border-nebula/30 bg-deep-space/60 px-2.5 py-1.5 text-sm text-starlight placeholder:text-starlight/30 focus:border-nebula focus:outline-none';
const intervals = [[60, 'Every hour'], [240, 'Every 4 hours'], [720, 'Every 12 hours'], [1440, 'Once a day'], [10080, 'Once a week']] as const;
const at = (iso: string | null) => iso ? formatRelative(Date.parse(iso) / 1000) : '';

export function RunSummary({ run }: { run: ArchiveRun }) {
  const tone = run.status === 'done' && !run.errors ? 'text-emerald-300' : run.status === 'running' ? 'text-sky-300' : run.status === 'cancelled' ? 'text-starlight/60' : 'text-amber-300';
  return (
    <span className="text-xs text-starlight/60">
      <span className={tone}>{run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : run.status === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
      {' '}{at(run.finishedAt ?? run.startedAt)} · {run.added} new, {run.updated} updated, {run.unchanged} unchanged
      {run.skipped ? `, ${run.skipped} skipped` : ''}{run.blocked ? `, ${run.blocked} removed` : ''}{run.errors ? `, ${run.errors} errors` : ''}
      {run.error && <span className="block text-amber-300/80">{run.error}</span>}
    </span>
  );
}

function SettingInput({ spec, value, onChange }: { spec: ArchiveSource['settingSpecs'][number]; value: SettingValue; onChange: (value: SettingValue) => void }) {
  if (spec.type === 'boolean') {
    return <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{spec.label}</label>;
  }
  return (
    <label className="block space-y-1 text-xs text-starlight/60">
      <span>{spec.label}</span>
      {spec.type === 'choice' ? (
        <select className={field} value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {spec.choices?.map((choice) => <option key={choice.value} value={choice.value} className="bg-surface-1">{choice.label}</option>)}
        </select>
      ) : spec.type === 'number' ? (
        <input className={field} type="number" value={Number(value)} min={spec.min} max={spec.max} onChange={(event) => onChange(Number(event.target.value))} />
      ) : spec.type === 'list' ? (
        <input className={field} value={(value as string[]).join(', ')} placeholder="Comma-separated"
          onChange={(event) => onChange(event.target.value.split(',').map((item) => item.trimStart()))} />
      ) : (
        <input className={field} value={String(value)} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function SourceCard({ source, onChanged }: { source: ArchiveSource; onChanged: () => void }) {
  const archiveApi = useArchiveApi();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(source.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ArchiveRun[] | null>(null);
  const operation = useRef<AbortController | null>(null), history = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); history.current?.abort(); }, [archiveApi, source.provider]);
  useEffect(() => { setSettings(source.settings); }, [source.settings]);

  async function act(task: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(null);
    try { await task(controller.signal); if (!controller.signal.aborted) onChanged(); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'That did not work'); }
    finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  const save = () => act(async (signal) => {
    const cleaned = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : value]));
    const changedSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ''));
    setSecrets({});
    await archiveApi.saveSource(source.provider, { settings: cleaned, ...(Object.keys(changedSecrets).length ? { secrets: changedSecrets } : {}) }, signal);
  });

  return (
    <div className="rounded-lg border border-nebula/20 bg-deep-space/30">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2 font-medium">
          <input type="checkbox" checked={source.enabled} disabled={busy} onChange={(event) => { const enabled = event.target.checked; void act((signal) => archiveApi.saveSource(source.provider, { enabled }, signal)); }} />
          {source.label}
        </label>
        <select className={cn(field, 'w-auto py-1 text-xs')} value={source.intervalMinutes} disabled={busy}
          onChange={(event) => { const intervalMinutes = Number(event.target.value); void act((signal) => archiveApi.saveSource(source.provider, { intervalMinutes }, signal)); }}>
          {intervals.map(([minutes, label]) => <option key={minutes} value={minutes} className="bg-surface-1">{label}</option>)}
          {!intervals.some(([minutes]) => minutes === source.intervalMinutes) && <option value={source.intervalMinutes}>Every {source.intervalMinutes} min</option>}
        </select>
        <div className="min-w-0 flex-1">
          {source.running ? <span className="text-xs text-sky-300">Running now…</span> : source.lastRun ? <RunSummary run={source.lastRun} /> : <span className="text-xs text-starlight/40">Never run</span>}
        </div>
        {source.running
          ? <button type="button" disabled={busy} onClick={() => act((signal) => archiveApi.cancel(source.running!, signal))} className="rounded-md border border-nebula/30 px-2.5 py-1 text-xs hover:border-nebula">Stop</button>
          : <button type="button" disabled={busy} onClick={() => act((signal) => archiveApi.run(source.provider, signal))} className="rounded-md bg-nebula px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">Run now</button>}
        <button type="button" onClick={() => {
          setOpen(!open); history.current?.abort();
          if (!open) { const controller = new AbortController(); history.current = controller;
            void archiveApi.runs(source.provider, controller.signal).then((value) => { if (!controller.signal.aborted) setRuns(value); })
              .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Run history is unavailable.'); }); }
        }}
          aria-expanded={open} className="text-xs text-starlight/50 hover:text-starlight">{open ? 'Close ▴' : 'Options ▾'}</button>
      </div>
      {error && <p role="alert" className="px-3 pb-2 text-xs text-red-300">{error}</p>}
      {open && (
        <div className="space-y-3 border-t border-nebula/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {source.settingSpecs.map((spec) => (
              <div key={spec.key} title={spec.help}>
                <SettingInput spec={spec} value={settings[spec.key] ?? spec.default} onChange={(value) => setSettings({ ...settings, [spec.key]: value })} />
                {spec.help && <p className="mt-0.5 text-[11px] text-starlight/40">{spec.help}</p>}
              </div>
            ))}
            {source.secretSpecs.map((spec) => (
              <label key={spec.key} className="block space-y-1 text-xs text-starlight/60">
                <span>{spec.label} {source.secretsSet.includes(spec.key) ? <span className="text-emerald-300">(saved)</span> : <span className="text-starlight/40">(not set)</span>}</span>
                <input className={field} type="password" autoComplete="off" value={secrets[spec.key] ?? ''} placeholder={source.secretsSet.includes(spec.key) ? 'Leave empty to keep' : ''}
                  onChange={(event) => setSecrets({ ...secrets, [spec.key]: event.target.value })} />
                {spec.help && <p className="text-[11px] text-starlight/40">{spec.help}</p>}
                {source.secretsSet.includes(spec.key) && (
                  <button type="button" disabled={busy} className="text-[11px] text-red-300 hover:underline" onClick={() => act((signal) => archiveApi.saveSource(source.provider, { secrets: { [spec.key]: null } }, signal))}>Remove</button>
                )}
              </label>
            ))}
          </div>
          <button type="button" disabled={busy} onClick={() => void save()} className="rounded-md bg-nebula px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">Save options</button>
          {runs && runs.length > 0 && (
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-starlight/40">Recent runs</h3>
              <ul className="space-y-1">{runs.slice(0, 8).map((run) => <li key={run.id}><RunSummary run={run} /></li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Settings → Archive: which sources the Archive scrapes, how often, and with what options and credentials. */
export function ArchiveSettings() {
  const archiveApi = useArchiveApi();
  const [sources, setSources] = useState<ArchiveSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    void archiveApi.sources(controller.signal).then((value) => { if (!controller.signal.aborted) { setSources(value); setError(null); } },
      (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Archive sources are unavailable.'); });
  }, [archiveApi]);
  useEffect(() => { setSources(null); setError(null); load(); return () => request.current?.abort(); }, [load]);
  // While something runs, follow its progress; new cards show up in the Archive as they land.
  const running = sources?.some((source) => source.running);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { load(); libraryChanged(); }, 3_000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (error) {
    return (
      <div className="text-sm text-starlight/70">
        <p className="text-amber-300">The Archive is not available: {error}</p>
        <p className="mt-1 text-xs text-starlight/50">Start the Archive service (UNITY_ARCHIVE_MODE=native) and point the API at it with UNITY_ARCHIVE_NATIVE_ORIGIN and UNITY_ARCHIVE_ADMIN_TOKEN.</p>
        <button type="button" onClick={load} className="mt-2 text-xs text-nebula hover:underline">Try again</button>
      </div>
    );
  }
  if (!sources) return <p className="text-sm text-starlight/50">Loading sources…</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-starlight/50">The Archive keeps every card it fetches, with each changed version. Turned-on sources run on their schedule; Run now starts one at once.</p>
      {sources.map((source) => <SourceCard key={source.provider} source={source} onChanged={load} />)}
    </div>
  );
}
