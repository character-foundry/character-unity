import { useEffect, useId, useRef, useState } from 'react';
import { useTileMenuPosition } from './menu-position';

interface CardMenuItem<Value extends string> { value: Value; label: string; hint?: string }

/** A tile action menu. The footer lives outside the clipped portrait so this can open above it. */
export function CardMenu<Value extends string>({ label, heading, icon, items, disabled = false, onSelect }: {
  label: string; heading: string; icon: React.ReactNode; items: readonly CardMenuItem<Value>[];
  disabled?: boolean; onSelect: (value: Value) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const position = useTileMenuPosition(root, menu, open);
  const focus = (index: number) => {
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (buttons?.length) buttons[(index + buttons.length) % buttons.length]?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div ref={root} className="relative" onClick={(event) => event.stopPropagation()}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} type="button" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        disabled={disabled} onClick={(event) => { event.preventDefault(); setOpen(!open); }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}
        className="grid h-7 w-7 place-items-center rounded text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:bg-white/15 disabled:opacity-50"
      >{icon}</button>
      {open && <div ref={menu} id={id} role="menu" aria-label={heading}
        onKeyDown={(event) => {
          const index = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])].indexOf(document.activeElement!);
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focus(index + (event.key === 'ArrowDown' ? 1 : -1)); }
          else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focus(event.key === 'Home' ? 0 : -1); }
          else if (event.key === 'Tab') { setOpen(false); trigger.current?.focus(); }
        }}
        style={{ transform: `translateX(${position.shiftX}px)`, maxHeight: position.maxHeight }}
        className={`absolute right-0 z-50 w-44 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-starlight/10 bg-surface-2 p-1 text-starlight shadow-xl shadow-black/50 ${position.below ? 'top-full mt-1' : 'bottom-full mb-1'}`}>
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-text-muted">{heading}</p>
        {items.map((item) => <button key={item.value} type="button" role="menuitem" tabIndex={-1}
          onClick={() => { setOpen(false); trigger.current?.focus(); onSelect(item.value); }}
          className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-[13px] hover:bg-starlight/5 focus:bg-starlight/10 focus:outline-none">
          {item.label}{item.hint && <span className="text-[11px] text-text-muted">{item.hint}</span>}
        </button>)}
      </div>}
    </div>
  );
}
