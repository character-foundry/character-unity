import { useLayoutEffect, useState, type RefObject } from 'react';

export function tileMenuPosition(anchor: { top: number; bottom: number; right: number }, menu: { width: number; height: number }, viewport: { width: number; height: number }) {
  const idealLeft = anchor.right - menu.width;
  const left = Math.max(8, Math.min(idealLeft, viewport.width - menu.width - 8));
  // Keep a first-row dense tile's menu out from under the fixed 48px application header.
  const aboveSpace = Math.max(0, anchor.top - 60), belowSpace = Math.max(0, viewport.height - anchor.bottom - 12);
  const below = aboveSpace < menu.height && belowSpace > aboveSpace;
  return { below, shiftX: left - idealLeft, maxHeight: below ? belowSpace : aboveSpace };
}

/** Measure only while open; no observer or idle polling for the card grid. */
export function useTileMenuPosition(root: RefObject<HTMLElement | null>, menu: RefObject<HTMLElement | null>, open: boolean) {
  const [position, setPosition] = useState<{ below: boolean; shiftX: number; maxHeight?: number }>({ below: false, shiftX: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!root.current || !menu.current) return;
      setPosition(tileMenuPosition(root.current.getBoundingClientRect(), { width: menu.current.offsetWidth, height: menu.current.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [root, menu, open]);
  return position;
}
