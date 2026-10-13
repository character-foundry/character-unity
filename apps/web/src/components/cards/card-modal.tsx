import { Link } from 'react-router';
import { Modal, ModalBody, MetadataBadge } from '@/components/ui';
import type { CardListItem } from '@/types/card';
import { cn } from '@/lib/utils/cn';
import { formatDate, stripHtml } from '@/lib/utils/format';
import { useSettings } from '@/lib/settings';
import { PlacementChips, SendMenu } from '@/components/chat/send-menu';
import { DeleteCardButton, FavoriteButton, FollowButton } from './card-actions';
import { CardFormatBadge } from './card-format-badge';
import type { ChatPlacement } from '@/lib/chat';

interface CardModalProps {
  card: CardListItem | null;
  isOpen: boolean;
  onClose: () => void;
  placements?: ChatPlacement[] | undefined;
}

export function CardModal({ card, isOpen, onClose, placements }: CardModalProps) {
  const { settings } = useSettings();
  if (!card) return null;
  const shouldBlur = settings.blurNsfwContent && card.tags.some((tag) => tag.slug === 'nsfw');
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" label={`Quick view: ${card.name}`}>
      <ModalBody className="p-0">
        <div className="flex flex-col lg:flex-row">
          <div className="relative aspect-[3/4] w-full shrink-0 lg:aspect-auto lg:min-h-[620px] lg:w-2/5">
            {(card.thumbnailPath || card.imagePath) ? (
              <img src={card.thumbnailPath || card.imagePath!} alt={card.name}
                className={cn('absolute inset-0 h-full w-full rounded-t-2xl object-cover lg:rounded-l-2xl lg:rounded-tr-none', shouldBlur && 'blur-xl')} />
            ) : <div className="flex h-full min-h-52 w-full items-center justify-center bg-cosmic-teal/50"><span className="text-8xl text-starlight/30">?</span></div>}
          </div>
          <div className="max-h-[660px] min-w-0 flex-1 space-y-5 overflow-y-auto p-6 lg:max-h-none">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="gradient-text break-words text-2xl font-bold">{card.name}</h2>
                <div className="mt-1 text-sm">
                  <Link to={`/?search=${encodeURIComponent(`creator:"${card.creator}"`)}`} onClick={onClose} className="text-starlight/60 hover:text-nebula">by <span className="text-nebula">{card.creator}</span></Link>
                  <FollowButton creator={card.creator} />
                </div>
              </div>
              <button type="button" aria-label="Close quick view" onClick={onClose} className="p-1 text-2xl leading-none text-starlight/60 hover:text-starlight">&times;</button>
            </div>
            {card.tags.length > 0 && <div className="flex flex-wrap gap-2">{card.tags.map((tag) =>
              <Link key={tag.id} to={`/?tags=${encodeURIComponent(tag.name)}`} onClick={onClose}
                className="rounded-full bg-nebula/20 px-2 py-1 text-xs text-nebula hover:bg-nebula/30">{tag.name}</Link>)}</div>}
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-deep-space/50 p-3">
              <CardFormatBadge format={card.sourceFormat} specVersion={card.specVersion} />
              <FavoriteButton key={`${card.id}:${card.isFavorited}`} cardId={card.id} initial={card.isFavorited} className="p-1" iconClassName="h-5 w-5" />
              {card.tokensTotal !== null && <span className="text-sm text-solar">{card.tokensTotal.toLocaleString()} tokens</span>}
              {card.isFork && <span className="rounded bg-nebula px-2 py-0.5 text-xs font-semibold text-white">FORK</span>}
              {card.reference && <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-xs font-semibold text-emerald-200">ARCHIVE LINK</span>}
              {card.forksCount !== null && card.forksCount > 0 && <span className="text-sm text-starlight/60">{card.forksCount} fork{card.forksCount === 1 ? '' : 's'}</span>}
              <span className="text-xs text-starlight/60" title={card.reference?.versionId}>{card.reference ? 'Pinned Archive version' : `Revision ${card.revisionCount}`}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <MetadataBadge type="greetings" count={card.totalGreetingsCount} variant="full" />
              <MetadataBadge type="lorebook" count={card.lorebookEntriesCount} variant="full" />
              <MetadataBadge type="assets" count={card.assetsCount} variant="full" />
            </div>
            {card.creatorNotes && <div><h3 className="mb-2 text-sm font-semibold text-starlight/70">Creator Notes</h3>
              <p className="line-clamp-4 rounded bg-deep-space/30 p-3 text-sm text-starlight/60">{stripHtml(card.creatorNotes)}</p></div>}
            <div className="flex flex-wrap gap-4 text-xs text-starlight/50">
              <span>Added: {formatDate(card.createdAt)}</span>
              {card.updatedAt !== card.createdAt && <span>Last edited: {formatDate(card.updatedAt)}</span>}
            </div>
            <div className="space-y-2 pt-2">
              <Link to={`/card/${encodeURIComponent(card.id)}`} onClick={onClose} className="btn-secondary block w-full py-2 text-center">View Full Profile</Link>
              <div className="flex gap-2">
                <Link to={`/card/${encodeURIComponent(card.id)}/edit`} onClick={onClose} className="btn-primary flex-1 py-2 text-center">Edit</Link>
                <Link to={`/card/${encodeURIComponent(card.id)}/fork`} onClick={onClose} className="btn-secondary flex-1 py-2 text-center" title="Your copy is created only when you save">Fork</Link>
              </div>
              {card.reference && <p className="text-xs text-starlight/60">This is a library link, not a copy. Changed Save creates your fork; the archived original remains read-only.</p>}
              <div className="flex items-center gap-2"><SendMenu cardId={card.id} placements={placements} variant="wide" className="flex-1" /><PlacementChips placements={placements} /></div>
              <DeleteCardButton cardId={card.id} name={card.name} reference={Boolean(card.reference)} onDeleted={onClose} className="w-full" />
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}
