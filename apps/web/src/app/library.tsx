import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppShell } from '@/components/layout';
import { CardGrid } from '@/components/cards/card-grid';
import { CardModal } from '@/components/cards/card-modal';
import { Button, Pagination } from '@/components/ui';
import { importFile, libraryId, listCards } from '@/lib/unity';
import { toListItem } from '@/lib/adapt';
import type { CardListItem } from '@/types/card';
import { CARDS_PER_PAGE } from '@/lib/constants';
import { usePlacements } from '@/lib/chat';

export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const tag = params.get('tags') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CardListItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const totalPages = Math.ceil(total / CARDS_PER_PAGE);
  const placements = usePlacements(cards.map((card) => card.id));

  const load = useCallback(async () => {
    setIsLoading(true); setError(null);
    try {
      const [workspace, result] = await Promise.all([libraryId(), listCards({ q: search, tag, offset: (page - 1) * CARDS_PER_PAGE, limit: CARDS_PER_PAGE })]);
      setCards(result.cards.map((summary) => toListItem(workspace, summary)));
      setTotal(result.total);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The library could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, [search, tag, page]);

  useEffect(() => { void load(); }, [load]);

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  async function importFiles(files: FileList) {
    setImporting(true); setNotice(null); setError(null);
    let imported = 0; const failed: string[] = [];
    for (const file of Array.from(files)) {
      try { await importFile(file); imported += 1; } catch { failed.push(file.name); }
    }
    setImporting(false);
    setNotice(`Imported ${imported} card${imported === 1 ? '' : 's'}.${failed.length ? ` Could not import: ${failed.join(', ')}` : ''}`);
    await load();
  }

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold gradient-text mb-2">Library</h1>
            <p className="text-starlight/60">Your imported cards and edited forks.</p>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileInput} type="file" multiple accept=".png,.json,.charx" className="hidden"
              onChange={(event) => { if (event.target.files?.length) void importFiles(event.target.files); event.target.value = ''; }} />
            <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={importing}>
              {importing ? 'Importing…' : 'Import cards'}
            </Button>
          </div>
        </div>

        {(search || tag) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            {search && (
              <button onClick={() => update({ search: null })} className="px-3 py-1 rounded-full bg-nebula/20 text-nebula hover:bg-nebula/30">
                “{search}” ✕
              </button>
            )}
            {tag && (
              <button onClick={() => update({ tags: null })} className="px-3 py-1 rounded-full bg-nebula/20 text-nebula hover:bg-nebula/30">
                Tag: {tag} ✕
              </button>
            )}
          </div>
        )}

        {notice && <div className="mb-4 p-3 glass rounded-lg border border-nebula/30 text-sm text-starlight/80" role="status">{notice}</div>}
        {error && <div className="mb-4 bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-3 text-red-200/90" role="alert">{error}</div>}

        {!isLoading && (
          <div className="mb-4 text-sm text-starlight/60">
            {total} {total === 1 ? 'character' : 'characters'}
            {totalPages > 1 && ` • Page ${page} of ${totalPages}`}
          </div>
        )}

        <CardGrid cards={cards} isLoading={isLoading} onQuickView={setSelectedCard} placements={placements} />

        {!isLoading && totalPages > 1 && (
          <Pagination currentPage={page} totalPages={totalPages} onPageChange={(next) => update({ page: String(next) })} className="mt-8" />
        )}

        <CardModal card={selectedCard} isOpen={!!selectedCard} onClose={() => setSelectedCard(null)} placements={selectedCard ? placements.get(selectedCard.id) : undefined} />
      </div>
    </AppShell>
  );
}
