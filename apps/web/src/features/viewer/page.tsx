import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { createWorkerTokenizer } from '@character-unity/editor/worker-tokenizer';
import { AppShell } from '@/components/layout';
import { libraryId, listAssets, openCard, type OpenedCard, type RevisionAssets } from '@/lib/unity';
import { displayDocument, toDetail } from '@/lib/adapt';
import type { TokenBreakdown } from '@/types/card';
import { CardDetailClient } from './profile';

const tokenFields = ['description', 'personality', 'scenario', 'mes_example', 'first_mes', 'system_prompt', 'post_history_instructions'] as const;

export default function CardDetailPage() {
  const { id = '' } = useParams();
  const [loaded, setLoaded] = useState<{ workspace: string; opened: OpenedCard } | null>(null);
  const [tokens, setTokens] = useState<TokenBreakdown | null>(null);
  const [tokenStatus, setTokenStatus] = useState<'counting' | 'ready' | 'unavailable'>('counting');
  const [assets, setAssets] = useState<RevisionAssets | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null); setTokens(null); setAssets(null); setError(null); setAssetError(null); setTokenStatus('counting');
    void (async () => {
      try {
        const workspace = await libraryId();
        if (controller.signal.aborted) return;
        const opened = await openCard(id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setLoaded({ workspace, opened });
        if (opened.revision.assets.some((asset) => asset.path !== 'portrait')) {
          void listAssets(id, opened.revision.id, controller.signal).then((value) => {
            if (!controller.signal.aborted) setAssets(value);
          }).catch((failure) => {
            if (!controller.signal.aborted) setAssetError(failure instanceof Error ? failure.message : 'Asset previews are unavailable.');
          });
        }
        const data = displayDocument(opened.revision.document).data;
        try {
          const [description, personality, scenario, mesExample, firstMes, systemPrompt, postHistory] = await createWorkerTokenizer().count(tokenFields.map((field) => data[field]), controller.signal);
          if (controller.signal.aborted) return;
          setTokens({ description, personality, scenario, mesExample, firstMes, systemPrompt, postHistory,
            total: description + personality + scenario + mesExample + firstMes + systemPrompt + postHistory });
          setTokenStatus('ready');
        } catch {
          if (!controller.signal.aborted) setTokenStatus('unavailable');
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'This card could not be opened.');
      }
    })();
    return () => controller.abort();
  }, [id, attempt]);

  if (error) return <AppShell><div className="glass space-y-4 rounded-xl p-8 text-center"><p role="alert" className="text-red-200">{error}</p>
    <button type="button" onClick={() => setAttempt((value) => value + 1)} className="btn-primary px-4 py-2">Retry</button><Link to="/" className="ml-3 text-nebula">Back to library</Link></div></AppShell>;
  if (!loaded) return <AppShell><div role="status" className="glass animate-pulse rounded-xl p-12 text-center text-starlight/50">Loading…</div></AppShell>;
  return <CardDetailClient key={loaded.opened.card.id} card={toDetail(loaded.workspace, loaded.opened, tokens, assets)} tokenStatus={tokenStatus} assetError={assetError} />;
}
