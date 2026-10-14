import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CardGrid } from '@/components/cards/card-grid';
import { CardModal } from '@/components/cards/card-modal';
import { toListItem } from '@/lib/adapt';
import type { CardDetail, CardListItem } from '@/types/card';
import { AppShell } from '@/components/layout';
import { buildCardExportFilename } from '@/lib/utils';
import { WhereItLives } from '@/components/chat/where-it-lives';
import type { CardFamily, ExportFormat } from '@/lib/unity';
import { useLibraryClient } from '@/lib/library-client';
import { CardHero, SectionTabs, NotesSection, CharacterSection, GreetingsSection, LorebookSection, AssetsSection, type Section } from './components';
import { ViewMediaProvider } from './components/utils';

interface CardDetailClientProps {
  card: CardDetail;
  tokenStatus: 'counting' | 'ready' | 'unavailable';
  assetError: string | null;
}
const extensions: Record<ExportFormat, string> = { json: 'json', png: 'png', charx: 'charx', 'sillytavern-json': 'json', 'sillytavern-png': 'png' };

export function CardDetailClient({ card, tokenStatus, assetError }: CardDetailClientProps) {
  const client = useLibraryClient();
  const [activeSection, setActiveSection] = useState<Section>('notes');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [family, setFamily] = useState<{ workspace: string; value: CardFamily } | null>(null);
  const [familyError, setFamilyError] = useState<string | null>(null);
  const [familyAttempt, setFamilyAttempt] = useState(0);
  const [selectedFork, setSelectedFork] = useState<CardListItem | null>(null);
  const data = card.cardData.data;

  useEffect(() => {
    const controller = new AbortController();
    setFamily(null); setFamilyError(null); setSelectedFork(null);
    void client.cardFamily(card.id, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setFamily({ workspace: client.workspaceId, value }); })
      .catch((failure) => { if (!controller.signal.aborted) setFamilyError(failure instanceof Error ? failure.message : 'Forks could not be loaded.'); });
    return () => controller.abort();
  }, [client, card.id, familyAttempt]);
  const forks = family ? family.value.forks.map((summary) => toListItem(family.workspace, summary)) : [];
  const isNsfw = card.tags.some((tag) => tag.slug === 'nsfw');
  const sections: { id: Section; label: string; available: boolean }[] = [
    { id: 'notes', label: "Creator's Notes", available: true },
    { id: 'character', label: 'Character Card', available: true },
    { id: 'greetings', label: 'Greetings', available: card.totalGreetingsCount > 0 },
    { id: 'lorebook', label: 'Lorebook', available: card.hasLorebook },
    { id: 'assets', label: 'Assets', available: true },
    { id: 'forks', label: `Forks${family ? ` (${family.value.forkTotal})` : ''}`, available: true },
  ];
  const media = useMemo(() => {
    const paths = new Map(card.savedAssets.map((asset) => [asset.binding, asset.path]));
    const resources: Record<string, string> = {};
    data.assets.forEach((asset, index) => { const path = paths.get(`declared/${index}`); if (path && asset.uri) resources[asset.uri] = path; });
    if (card.imagePath) resources.ccdefault = card.imagePath;
    return resources;
  }, [card.savedAssets, card.imagePath, data.assets]);

  async function download(action: () => Promise<void>) {
    setDownloadError(null); setDownloading(true);
    try { await action(); } catch (failure) { setDownloadError(failure instanceof Error ? failure.message : 'Download failed.'); }
    finally { setDownloading(false); }
  }
  const visibleSection = sections.some((section) => section.id === activeSection && section.available) ? activeSection : 'notes';

  return (
    <AppShell>
      <ViewMediaProvider value={media}>
        <div data-card-page data-card-slug={card.id} data-card-format={card.sourceFormat ?? ''}>
          <CardHero card={card} tokenStatus={tokenStatus} downloading={downloading}
            onDownload={(format) => void download(() => client.downloadExport(card.id, card.headRevisionId, format, buildCardExportFilename(card, extensions[format])))}
            onOriginal={() => void download(() => client.downloadOriginal(card.id, card.originalFilename!))}
            parent={family?.value.parent ? { id: family.value.parent.id, name: family.value.parent.name } : null} />
          <WhereItLives cardId={card.id} />
          {downloadError && <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/20 px-4 py-3 text-red-200">{downloadError}</div>}
          <SectionTabs sections={sections} activeSection={visibleSection} onSectionChange={setActiveSection} />
          <div className="min-w-0 w-full" data-card-content>
            <div className="glass min-w-0 rounded-xl p-4 sm:p-6" data-card-section={visibleSection}>
              {visibleSection === 'notes' && <NotesSection creatorNotes={data.creator_notes || card.creatorNotes} isNsfw={isNsfw} />}
              {visibleSection === 'character' && <CharacterSection cardData={card.cardData} tokens={card.tokens} rawDocument={card.rawDocument} />}
              {visibleSection === 'greetings' && <GreetingsSection firstMessage={data.first_mes} alternateGreetings={data.alternate_greetings} groupGreetings={data.group_only_greetings} firstMessageTokens={card.tokens?.firstMes} isNsfw={isNsfw} />}
              {visibleSection === 'lorebook' && data.character_book && <LorebookSection key={card.headRevisionId} characterBook={data.character_book} />}
              {visibleSection === 'assets' && <AssetsSection key={card.headRevisionId} assets={data.assets} savedAssets={card.savedAssets} error={assetError} />}
              {visibleSection === 'forks' && (familyError ? <div className="space-y-3"><p role="alert" className="text-red-200">{familyError}</p><button type="button" onClick={() => setFamilyAttempt((value) => value + 1)} className="btn-secondary px-3 py-2">Retry forks</button></div>
                : !family ? <p role="status" className="text-starlight/60">Loading forks…</p>
                : forks.length === 0 ? <div className="py-8 text-center text-starlight/60"><p className="mb-3">No forks of this card yet.</p><Link to={`/card/${encodeURIComponent(card.id)}/fork`} className="btn-primary inline-block px-4 py-2">Fork it</Link></div>
                : <CardGrid cards={forks} onQuickView={setSelectedFork} />)}
            </div>
          </div>
        </div>
      </ViewMediaProvider>
      <CardModal card={selectedFork} isOpen={!!selectedFork} onClose={() => setSelectedFork(null)} />
    </AppShell>
  );
}
