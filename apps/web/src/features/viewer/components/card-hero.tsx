import { Link, useNavigate } from 'react-router';
import { Button, CoinIcon, MetadataBadge } from '@/components/ui';
import type { CardDetail, TokenBreakdown } from '@/types/card';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import type { ExportFormat } from '@/lib/unity';
import { SendMenu } from '@/components/chat/send-menu';
import { DeleteCardButton, FavoriteButton, FollowButton } from '@/components/cards/card-actions';
import { CardFormatBadge } from '@/components/cards/card-format-badge';

interface CardHeroProps {
  card: CardDetail;
  tokenStatus: 'counting' | 'ready' | 'unavailable';
  onDownload: (format: ExportFormat) => void;
  onOriginal: () => void;
  downloading: boolean;
  parent: { id: string; name: string } | null;
}
const tokenRows: { label: string; key: keyof TokenBreakdown }[] = [
  { label: 'Description', key: 'description' }, { label: 'Personality', key: 'personality' }, { label: 'Scenario', key: 'scenario' },
  { label: 'First Message', key: 'firstMes' }, { label: 'Examples', key: 'mesExample' }, { label: 'System Prompt', key: 'systemPrompt' }, { label: 'Post History', key: 'postHistory' },
];

export function CardHero({ card, tokenStatus, onDownload, onOriginal, downloading, parent }: CardHeroProps) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const shouldBlur = settings.blurNsfwContent && card.tags.some((tag) => tag.slug === 'nsfw');
  const permanentTokens = card.tokens ? card.tokens.description + card.tokens.personality + card.tokens.scenario + card.tokens.systemPrompt + card.tokens.postHistory : null;
  return (
    <div className="relative mb-4 overflow-hidden rounded-xl" data-card-hero>
      <div className="absolute inset-0 z-10 bg-gradient-to-r from-deep-space via-deep-space/80 to-transparent" data-card-hero-overlay />
      {card.imagePath && <div className="absolute inset-0" data-card-hero-bg><img src={card.imagePath} alt="" className="h-full w-full object-cover opacity-30 blur-sm" /></div>}
      <div className="relative z-20 flex flex-col gap-6 p-4 sm:p-6 xl:flex-row" data-card-hero-content>
        <div className="shrink-0" data-card-image-container>
          <div className="relative h-72 w-52 overflow-hidden rounded-lg border-2 border-nebula/30 shadow-xl" data-card-image>
            {card.imagePath ? <img src={card.imagePath} alt={card.name} className={cn('h-full w-full object-cover', shouldBlur && 'blur-xl')} /> :
              <div className="flex h-full w-full items-center justify-center bg-cosmic-teal/50"><svg aria-hidden="true" viewBox="0 0 24 24" className="h-24 w-24 text-nebula/40" fill="none" stroke="currentColor" strokeWidth="1"><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0116 0v2" /></svg></div>}
          </div>
        </div>
        <div className="min-w-0 flex-1" data-card-info>
          <h1 className="gradient-text mb-1 break-words text-3xl font-bold" data-card-name>{card.name}</h1>
          <div className="mb-2 text-sm" data-card-creator><Link to={`/?search=${encodeURIComponent(`creator:"${card.creator}"`)}`} className="text-starlight/60 hover:text-nebula">by <span className="text-nebula">{card.creator}</span></Link><FollowButton creator={card.creator} /></div>
          <p className="mb-3 line-clamp-2 text-sm text-starlight/70" data-card-description>{card.description || 'No description provided.'}</p>
          {card.tags.length > 0 && <div className="mb-4 flex flex-wrap gap-1.5" data-card-tags>{card.tags.map((tag) =>
            <Link key={tag.id} to={`/?tags=${encodeURIComponent(tag.name)}`} className="rounded-full bg-nebula/20 px-2 py-1 text-xs text-nebula hover:bg-nebula/30">{tag.name}</Link>)}</div>}
          {parent && <Link to={`/card/${encodeURIComponent(parent.id)}`} className="mb-4 flex w-fit items-center gap-2 rounded-lg border border-nebula/30 bg-nebula/10 px-3 py-2 text-sm text-nebula"><span className="text-xs text-starlight/60">Forked from</span>{parent.name}</Link>}
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-deep-space/50 p-3" data-card-stats>
            <CardFormatBadge format={card.sourceFormat} specVersion={card.specVersion} />
            <FavoriteButton key={`${card.id}:${card.isFavorited}`} cardId={card.id} initial={card.isFavorited} className="p-1" iconClassName="h-5 w-5" />
            {card.isFork && <span className="rounded bg-nebula px-2 py-0.5 text-xs font-semibold text-white">FORK</span>}
            {card.reference && <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-xs font-semibold text-emerald-200">ARCHIVE LINK</span>}
            <span className="text-xs text-starlight/60" title={card.reference ? 'Exact archived version' : 'Saved revisions'}>{card.reference ? 'Archive version' : 'Revision'} {card.revisionCount}</span>
            <MetadataBadge type="greetings" count={card.totalGreetingsCount} variant="full" />
            <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} variant="full" />
            <MetadataBadge type="assets" count={card.assetsCount} variant="full" />
          </div>
          <div className="flex flex-wrap gap-2" data-card-actions>
            <Link to={`/card/${encodeURIComponent(card.id)}/edit`} className="btn-primary px-3 py-1.5 text-sm">Edit</Link>
            <Link to={`/card/${encodeURIComponent(card.id)}/fork`} className="btn-secondary px-3 py-1.5 text-sm" title="Your copy is created only when you save">Fork</Link>
            <SendMenu cardId={card.id} />
            {card.originalFilename && <Button variant="secondary" size="sm" disabled={downloading} onClick={onOriginal}>Download original</Button>}
            {card.imagePath && <Button variant="secondary" size="sm" disabled={downloading} onClick={() => onDownload('png')}>Download PNG</Button>}
            <Button variant="secondary" size="sm" disabled={downloading} onClick={() => onDownload('json')}>Export JSON</Button>
            <Button variant="secondary" size="sm" disabled={downloading} onClick={() => onDownload('charx')}>Export CharX</Button>
            {card.imagePath && <Button variant="ghost" size="sm" disabled={downloading} onClick={() => onDownload('sillytavern-png')}>SillyTavern PNG</Button>}
            <DeleteCardButton cardId={card.id} name={card.name} reference={Boolean(card.reference)} onDeleted={() => navigate('/')} />
          </div>
          {card.reference && <p className="mt-3 text-xs text-starlight/60">Linked to Archive version <span className="break-all font-mono">{card.reference.versionId}</span>. The original stays read-only; saving changed edits creates your fork. Removing this link does not delete the original.</p>}
          {card.archiveSource && <p className="mt-3 text-xs text-starlight/60">Your fork of Archive card <span className="font-mono">{card.archiveSource.cardId}</span>, version <span className="break-all font-mono">{card.archiveSource.versionId}</span>. Unchanged files remain referenced from that version.</p>}
        </div>
        <div className="w-full shrink-0 xl:w-56" data-card-tokens-container>
          <div className="glass rounded-lg border border-nebula/20 p-4" data-card-tokens>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-starlight/80"><CoinIcon className="h-4 w-4 text-solar" />Token Breakdown</h2>
            {card.tokens ? <dl className="space-y-2 text-xs">{tokenRows.map(({ key, label }) => <div key={key} className="flex justify-between gap-3"><dt className="text-starlight/50">{label}</dt><dd>{card.tokens![key].toLocaleString()}</dd></div>)}
              <div className="mt-2 flex justify-between border-t border-nebula/20 pt-2 font-semibold text-nebula"><dt>Total</dt><dd>{card.tokens.total.toLocaleString()}</dd></div>
              <div className="flex justify-between text-starlight/40"><dt>Permanent</dt><dd>{permanentTokens!.toLocaleString()}</dd></div>
            </dl> : <p className="text-xs text-starlight/50">{tokenStatus === 'counting' ? 'Counting…' : 'Token count unavailable.'}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
