import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { createWorkerTokenizer } from '@character-unity/editor/worker-tokenizer';
import { AppShell } from '@/components/layout';
import { libraryId, openCard, type OpenedCard } from '@/lib/unity';
import { toDetail } from '@/lib/adapt';
import type { TokenBreakdown } from '@/types/card';
import { CardDetailClient } from './client';

const tokenFields = ['description', 'personality', 'scenario', 'mes_example', 'first_mes', 'system_prompt', 'post_history_instructions'] as const;

export default function CardDetailPage() {
  const { id = '' } = useParams();
  const [loaded, setLoaded] = useState<{ workspace: string; opened: OpenedCard } | null>(null);
  const [tokens, setTokens] = useState<TokenBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null); setTokens(null); setError(null);
    let shown = false;
    void (async () => {
      try {
        const [workspace, opened] = await Promise.all([libraryId(), openCard(id)]);
        if (controller.signal.aborted) return;
        setLoaded({ workspace, opened }); shown = true;
        const data = (opened.revision.document as { data?: Record<string, unknown> }).data ?? {};
        const texts = tokenFields.map((field) => (typeof data[field] === 'string' ? data[field] as string : ''));
        const [description, personality, scenario, mesExample, firstMes, systemPrompt, postHistory] = await createWorkerTokenizer().count(texts, controller.signal);
        setTokens({ description, personality, scenario, mesExample, firstMes, systemPrompt, postHistory,
          total: description + personality + scenario + mesExample + firstMes + systemPrompt + postHistory });
      } catch (failure) {
        if (!controller.signal.aborted && !shown) setError(failure instanceof Error ? failure.message : 'This card could not be opened.');
      }
    })();
    return () => controller.abort();
  }, [id]);

  if (error) return <AppShell><div className="glass rounded-xl p-12 text-center text-starlight/70">{error}</div></AppShell>;
  if (!loaded) return <AppShell><div className="glass rounded-xl p-12 text-center text-starlight/50 animate-pulse">Loading…</div></AppShell>;
  return <CardDetailClient card={toDetail(loaded.workspace, loaded.opened, tokens)} tokensReady={tokens !== null} />;
}
