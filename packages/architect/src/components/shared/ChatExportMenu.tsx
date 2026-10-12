import { useEffect, useRef, useState } from 'react';

interface ChatExportMenuProps {
  onLumiverse?: () => Promise<void>;
  onSillyTavern?: () => Promise<void>;
  variant?: 'button' | 'icon';
  placement?: 'above' | 'below';
}

export function ChatExportMenu({ onLumiverse, onSillyTavern, variant = 'button', placement = 'below' }: ChatExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = [
    { label: 'Lumiverse', send: onLumiverse },
    { label: 'SillyTavern', send: onSillyTavern },
  ].filter(option => option.send);
  const iconOnly = variant === 'icon';
  const buttonClassName = iconOnly
    ? 'p-1.5 bg-black/40 hover:bg-black/60 rounded text-white/70 hover:text-white transition-colors disabled:opacity-50'
    : 'btn-secondary whitespace-nowrap';
  const icon = sending ? (
    <span aria-hidden="true" className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
  ) : (
    <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 6 9 7 9-7" />
    </svg>
  );

  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  async function send(option: typeof options[number]) {
    if (sending) return;
    setOpen(false);
    trigger.current?.focus();
    setSending(true);
    try { await option.send?.(); }
    finally { setSending(false); }
  }

  if (!options.length) return null;
  if (options.length === 1) return (
    <button ref={trigger} type="button" className={buttonClassName} disabled={sending}
      aria-label={iconOnly ? sending ? 'Sending…' : `Send to ${options[0].label}` : undefined}
      title={`Send to ${options[0].label}`} onClick={event => { event.stopPropagation(); void send(options[0]); }}>
      {iconOnly ? icon : sending ? 'Sending…' : options[0].label}
    </button>
  );

  return (
    <div ref={container} className={`relative ${open ? 'z-[100]' : ''}`} onClick={event => event.stopPropagation()} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={event => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) return setOpen(true);
        const items = [...(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      <button ref={trigger} type="button" className={buttonClassName} disabled={sending}
        aria-label={iconOnly ? sending ? 'Sending…' : 'Send to chat' : undefined}
        title={iconOnly ? 'Send to SillyTavern or Lumiverse' : undefined}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {iconOnly ? icon : sending ? 'Sending…' : 'Chat Export ▾'}
      </button>
      {open && (
        <div role="menu" aria-label="Chat Export" className={`absolute right-0 ${placement === 'above' ? 'bottom-full mb-1' : 'mt-1'} bg-dark-surface border border-dark-border rounded shadow-lg z-50 min-w-[160px]`}>
          {options.map(option => (
            <button key={option.label} type="button" role="menuitem"
              className="block w-full px-4 py-2 text-left hover:bg-slate-700 focus:bg-slate-700 first:rounded-t last:rounded-b"
              onClick={() => void send(option)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
