'use client';

import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { CardGrid } from '@/components/cards/card-grid';
import { CardModal } from '@/components/cards/card-modal';
import { toListItem } from '@/lib/adapt';
import type { CardListItem } from '@/types/card';
import { AppShell } from '@/components/layout';
import type { CardDetail } from '@/types/card';
import { buildCardExportFilename } from '@/lib/utils';
import { features } from '@/lib/features';
import { WhereItLives } from '@/components/chat/where-it-lives';
import { cardFamily, downloadExport, forkCard, libraryId, type CardFamily, type ExportFormat } from '@/lib/unity';
import {
  CardHero,
  SectionTabs,
  UploaderInfo,
  NotesSection,
  CharacterSection,
  GreetingsSection,
  LorebookSection,
  AssetsSection,
  CommentsSection,
  type Section,
} from './components';

interface CardDetailClientProps {
  card: CardDetail;
  tokensReady: boolean;
}

const extensions: Record<ExportFormat, string> = { json: 'json', png: 'png', charx: 'charx', 'sillytavern-json': 'json', 'sillytavern-png': 'png' };

export function CardDetailClient({ card: displayCard, tokensReady }: CardDetailClientProps) {
  const [activeSection, setActiveSection] = useState<Section>('notes');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [family, setFamily] = useState<{ workspace: string; value: CardFamily } | null>(null);
  const [forking, setForking] = useState(false);
  const [selectedFork, setSelectedFork] = useState<CardListItem | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    setFamily(null); setSelectedFork(null); setForking(false);
    Promise.all([libraryId(), cardFamily(displayCard.id)])
      .then(([workspace, value]) => { if (active) setFamily({ workspace, value }); })
      .catch(() => { /* The profile still works without fork data. */ });
    return () => { active = false; };
  }, [displayCard.id]);
  const forks = family ? family.value.forks.map((summary) => toListItem(family.workspace, summary)) : [];

  const handleFork = async () => {
    setForking(true); setDownloadError(null);
    try {
      const created = await forkCard(displayCard.id);
      navigate(`/card/${created.card.id}/edit`);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Fork failed');
      setForking(false);
    }
  };

  // Check if card has NSFW tag (for passing to child components)
  const isNsfw = displayCard.tags.some(tag => tag.slug === 'nsfw');

  // Calculate permanent token count (always sent: description + personality + scenario + system_prompt + post_history)
  const permanentTokens = useMemo(() => {
    return displayCard.tokens.description +
           displayCard.tokens.personality +
           displayCard.tokens.scenario +
           displayCard.tokens.systemPrompt +
           displayCard.tokens.postHistory;
  }, [displayCard.tokens]);

  const v3Assets = displayCard.cardData.spec === 'chara_card_v3' ? displayCard.cardData.data.assets : undefined;
  const hasAssets = !!(v3Assets && v3Assets.length > 0);

  const sections: { id: Section; label: string; available: boolean }[] = [
    { id: 'notes', label: "Creator's Notes", available: true },
    { id: 'character', label: 'Character Card', available: true },
    { id: 'greetings', label: 'Greetings', available: displayCard.hasAlternateGreetings || !!displayCard.cardData.data.first_mes },
    { id: 'lorebook', label: 'Lorebook', available: displayCard.hasLorebook },
    { id: 'assets', label: 'Assets', available: hasAssets },
    { id: 'forks', label: `Forks${family ? ` (${family.value.forkTotal})` : ''}`, available: true },
    { id: 'comments', label: 'Comments', available: features.social },
  ];

  const handleDownload = async (format: ExportFormat) => {
    setDownloadError(null);
    try {
      await downloadExport(displayCard.id, displayCard.headRevisionId, format, buildCardExportFilename(displayCard, extensions[format]));
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Export failed');
    }
  };

  return (
    <AppShell>
      <div data-card-page data-card-slug={displayCard.slug} data-card-format={displayCard.sourceFormat}>
      <CardHero
        card={displayCard}
        permanentTokens={permanentTokens}
        tokensReady={tokensReady}
        onDownload={handleDownload}
        onFork={handleFork}
        forking={forking}
        parent={family?.value.parent ? { id: family.value.parent.id, name: family.value.parent.name } : null}
      />
      <WhereItLives cardId={displayCard.id} />
      {downloadError && (
        <div className="mb-4 bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-3 text-red-200/90" role="alert">{downloadError}</div>
      )}

      <SectionTabs
        sections={sections}
        activeSection={activeSection}
        onSectionChange={setActiveSection}
      />

      <div className="w-full" data-card-content>
        <div className="glass rounded-xl p-6" data-card-section={activeSection}>
          {activeSection === 'notes' && (
            <NotesSection creatorNotes={displayCard.cardData.data.creator_notes || displayCard.creatorNotes} isNsfw={isNsfw} />
          )}

          {activeSection === 'character' && (
            <CharacterSection cardData={displayCard.cardData} tokens={displayCard.tokens} />
          )}

          {activeSection === 'greetings' && (
            <GreetingsSection
              firstMessage={displayCard.cardData.data.first_mes}
              alternateGreetings={displayCard.cardData.data.alternate_greetings}
              firstMessageTokens={displayCard.tokens.firstMes}
              isNsfw={isNsfw}
            />
          )}

          {activeSection === 'lorebook' && displayCard.cardData.data.character_book && (
            <LorebookSection characterBook={displayCard.cardData.data.character_book} />
          )}

          {activeSection === 'assets' && hasAssets && (
            <AssetsSection assets={v3Assets} savedAssets={displayCard.savedAssets} />
          )}

          {activeSection === 'forks' && (
            forks.length === 0 ? (
              <div className="text-center py-8 text-starlight/60">
                <p className="mb-3">No forks of this card yet.</p>
                <button onClick={handleFork} disabled={forking} className="btn-primary px-4 py-2">{forking ? 'Forking…' : 'Fork it'}</button>
              </div>
            ) : (
              <CardGrid cards={forks} onQuickView={setSelectedFork} />
            )
          )}

          {features.social && activeSection === 'comments' && (
            <CommentsSection cardId={displayCard.id} commentsCount={displayCard.commentsCount} />
          )}
        </div>

        {features.social && displayCard.uploader && (
          <UploaderInfo uploader={displayCard.uploader} createdAt={displayCard.createdAt} />
        )}
      </div>
      </div>
      <CardModal card={selectedFork} isOpen={!!selectedFork} onClose={() => setSelectedFork(null)} />
    </AppShell>
  );
}
