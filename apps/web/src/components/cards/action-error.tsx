import { useRef } from 'react';
import { useTileMenuPosition } from './menu-position';

/** Contextual failure beside a tile action, never cut off at a viewport edge. */
export function ActionError({ message, onDismiss, dismissLabel = 'Dismiss error' }: { message: string; onDismiss?: () => void; dismissLabel?: string }) {
  const anchor = useRef<HTMLSpanElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const position = useTileMenuPosition(anchor, bubble, true);
  return <span ref={anchor} className="relative inline-flex">
    <span ref={bubble} role="alert" style={{ transform: `translateX(${position.shiftX}px)`, maxHeight: position.maxHeight }}
      className={`absolute right-0 z-50 w-56 max-w-[calc(100vw-1rem)] overflow-y-auto whitespace-normal break-words rounded-md border border-red-500/40 bg-surface-2 p-2 text-xs text-red-200 shadow-xl shadow-black/50 ${position.below ? 'top-full mt-1' : 'bottom-full mb-1'}`}>
      {message}{onDismiss && <button type="button" aria-label={dismissLabel} onClick={onDismiss} className="ml-2 rounded px-1 text-starlight/70 hover:text-starlight">✕</button>}
    </span>
  </span>;
}
