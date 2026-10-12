import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { HeartIcon } from '@/components/ui';
import { deleteCard, followCreator, setFavorite } from '@/lib/unity';
import { libraryChanged, useFollowedCreators } from '@/lib/library-search';

/** Local favorite toggle (stored in this library, no account needed). */
export function FavoriteButton({ cardId, initial, className, iconClassName = 'h-3.5 w-3.5' }: { cardId: string; initial: boolean; className?: string; iconClassName?: string }) {
  const [favorite, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy} aria-pressed={favorite} title={favorite ? 'Remove from favorites' : 'Add to favorites'}
      onClick={async (event) => {
        event.stopPropagation(); event.preventDefault();
        setBusy(true); setValue(!favorite);
        try { await setFavorite(cardId, !favorite); } catch { setValue(favorite); } finally { setBusy(false); }
      }}
      className={cn('flex items-center transition-colors hover:text-pink-400', favorite ? 'text-pink-400' : 'text-white/70', className)}>
      <HeartIcon className={iconClassName} filled={favorite} />
    </button>
  );
}

/** Follow a creator in this library; "Followed creators only" filters on it. */
export function FollowButton({ creator }: { creator: string }) {
  const followed = useFollowedCreators();
  const following = followed.some((name) => name.trim().toLowerCase() === creator.trim().toLowerCase());
  const [busy, setBusy] = useState(false);
  // Cards without a creator read as Anonymous; that is not one person to follow.
  if (creator.trim().toLowerCase() === 'anonymous') return null;
  return (
    <button type="button" disabled={busy}
      onClick={async (event) => {
        event.stopPropagation(); event.preventDefault(); setBusy(true);
        try { await followCreator(creator, !following); libraryChanged(); } finally { setBusy(false); }
      }}
      className={cn('ml-2 rounded-full border px-2 py-0.5 text-xs align-middle transition-colors disabled:opacity-50',
        following ? 'border-nebula/50 bg-nebula/20 text-nebula' : 'border-nebula/30 text-starlight/60 hover:border-nebula hover:text-nebula')}>
      {following ? 'Following' : '+ Follow'}
    </button>
  );
}

/** Deletes a card from the library after confirmation. */
export function DeleteCardButton({ cardId, name, onDeleted, className }: { cardId: string; name: string; onDeleted: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy}
      onClick={async () => {
        if (!window.confirm(`Delete “${name}” from the library? Copies already sent to chat apps stay there.`)) return;
        setBusy(true);
        try { await deleteCard(cardId); libraryChanged(); onDeleted(); }
        catch (error) { window.alert(error instanceof Error ? error.message : 'The card could not be deleted'); setBusy(false); }
      }}
      className={cn('inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50', className)}>
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      {busy ? 'Deleting…' : 'Delete'}
    </button>
  );
}
