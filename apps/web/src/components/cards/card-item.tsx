import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CardListItem, SourceFormat } from '@/types/card';
import { useSettings } from '@/lib/settings';
import type { UserSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { formatRelative } from '@/lib/utils/format';
import { DownloadIcon, MetadataBadge } from '@/components/ui';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import { FavoriteButton } from './card-actions';
import type { ChatPlacement } from '@/lib/chat';
import type { ExportFormat } from '@/lib/unity';
import { useLibraryClient } from '@/lib/library-client';
import { ProtectedImage } from '@/components/ui/protected-media';
import { buildCardExportFilename } from '@/lib/utils';
import { CardMenu } from './card-menu';
import { exportExtension, tileExportFormats } from './export-formats';
import { ForkIcon, TileTokens, tileBadge } from './tile-presentation';
import { ActionError } from './action-error';

// CharX/Voxta show the package format; PNG/JSON show the document spec.
function formatLabel(format: SourceFormat | null, specVersion: string) {
  return (format === 'charx' || format === 'voxta' ? format : specVersion).toUpperCase();
}

interface CardItemProps {
  card: CardListItem;
  size?: UserSettings['cardSize'];
  onQuickView?: (card: CardListItem) => void;
  placements?: ChatPlacement[] | undefined;
}

/** A native library tile: portrait, real metadata and persistent actions at every density. */
export function CardItem({ card, size = 'medium', onQuickView, placements }: CardItemProps) {
  const client = useLibraryClient();
  const { settings } = useSettings();
  const small = size === 'small';
  const maxTags = size === 'large' ? 3 : 2;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { request.current++; setExportError(null); setExporting(false); return () => { request.current++; }; }, [client, card.id, card.headRevisionId]);
  const isNsfw = card.tags.some((tag) => tag.slug === 'nsfw');
  const shouldBlur = settings.blurNsfwContent && isNsfw;

  async function exportCard(format: ExportFormat) {
    const generation = ++request.current;
    setExporting(true); setExportError(null);
    try { await client.downloadExport(card.id, card.headRevisionId, format, buildCardExportFilename(card, exportExtension(format))); }
    catch (error) { if (request.current === generation) setExportError(error instanceof Error ? error.message : 'Export failed'); }
    finally { if (request.current === generation) setExporting(false); }
  }

  return (
    <article className="group relative scroll-mt-28 focus-within:z-30">
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-2 ring-1 ring-starlight/[0.06] transition-shadow hover:ring-starlight/20">
        {(card.thumbnailPath || card.imagePath) ? (
          <ProtectedImage src={card.thumbnailPath || card.imagePath!} alt="" loading="lazy" decoding="async"
            className={cn('pointer-events-none absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100', shouldBlur && 'blur-xl')} />
        ) : (
          <div className="pointer-events-none flex h-full items-center justify-center">
            <span aria-hidden="true" className="flex h-16 w-16 items-center justify-center rounded-2xl bg-starlight/5 text-xl font-semibold text-starlight/25">CU</span>
          </div>
        )}
        {onQuickView ? (
          <button type="button" aria-label={`Quick view ${card.name}`} onClick={() => onQuickView(card)}
            className="absolute inset-0 cursor-pointer rounded-lg focus-visible:-outline-offset-2 focus-visible:outline-nebula" />
        ) : (
          <Link to={`/card/${encodeURIComponent(card.id)}`} aria-label={`View ${card.name}`}
            className="absolute inset-0 rounded-lg focus-visible:-outline-offset-2 focus-visible:outline-nebula" />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

        <div className="pointer-events-none absolute left-1.5 top-1.5 flex max-w-[52%] flex-wrap gap-1">
          <MetadataBadge type="greetings" count={card.totalGreetingsCount} className={tileBadge} />
          <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} className={tileBadge} />
          {!small && <MetadataBadge type="images" count={card.embeddedImagesCount} className={tileBadge} />}
          {!small && <MetadataBadge type="assets" count={card.assetsCount} className={tileBadge} />}
        </div>
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex max-w-[48%] flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1">
            {card.isFork && <span className="flex items-center gap-0.5 rounded bg-nebula/85 px-1 py-0.5 text-[10px] font-semibold text-white" title="Your edited fork. Open the card to inspect its source."><ForkIcon />FORK</span>}
            {card.reference && <span className="rounded bg-emerald-900/90 px-1 py-0.5 text-[10px] font-semibold text-emerald-200" title="Exact Archive version; original files stay in Archive">ARCHIVE</span>}
            {card.forksCount !== null && card.forksCount > 0 && !small && <span className={tileBadge} title={`${card.forksCount} fork${card.forksCount === 1 ? '' : 's'}`}><ForkIcon />{card.forksCount}</span>}
            <span className={tileBadge}>{formatLabel(card.sourceFormat, card.specVersion)}</span>
          </div>
          <TileTokens count={card.tokensTotal} />
          <PlacementChips placements={placements} className="px-1 py-0.5 text-[10px] font-semibold" />
        </div>

        <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 px-2', small ? 'pb-9' : 'pb-10')}>
          <h3 className={cn('truncate font-semibold leading-tight text-white drop-shadow', small ? 'text-[12px]' : 'text-[13px]')}>{card.name}</h3>
          <p className="truncate text-[11px] leading-tight text-white/65">by {card.creator}</p>
          {!small && card.tags.length > 0 && <ul className="mt-1.5 flex gap-1 overflow-hidden" aria-label="Tags">
            {card.tags.slice(0, maxTags).map((tag) => <li key={tag.id} className="shrink-0">
              <Link to={`/?tags=${encodeURIComponent(tag.name)}`} className="pointer-events-auto relative z-10 block whitespace-nowrap rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/85 backdrop-blur-sm hover:bg-white/20">{tag.name}</Link>
            </li>)}
            {card.tags.length > maxTags && <li className="shrink-0 px-0.5 py-px text-[10px] font-medium text-white/55">+{card.tags.length - maxTags}</li>}
          </ul>}
        </div>
      </div>

      {/* Outside the portrait clip: keyboard focus, menus and failures must remain visible. */}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 px-1.5 pb-1.5 text-[11px] text-white/65">
        <FavoriteButton cardId={card.id} initial={card.isFavorited ?? false} className="grid h-7 w-7 place-items-center rounded hover:bg-white/15" />
        {isNsfw && <span title="NSFW" aria-label="NSFW" className="shrink-0 text-[9px] font-semibold text-orange-300">18+</span>}
        {!small && <span className="min-w-0 truncate" title="Last edited">{formatRelative(card.updatedAt)}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <SendMenu cardId={card.id} placements={placements} variant="icon" />
          <CardMenu label={exporting ? `Exporting ${card.name}…` : `Export ${card.name}`} heading="Export as" disabled={exporting}
            icon={<DownloadIcon className={cn('h-3.5 w-3.5', exporting && 'animate-pulse')} />} items={tileExportFormats(Boolean(card.imagePath))}
            onSelect={(format) => void exportCard(format)} />
          {exportError && <ActionError message={exportError} onDismiss={() => setExportError(null)} dismissLabel="Dismiss export error" />}
        </div>
      </div>
    </article>
  );
}
