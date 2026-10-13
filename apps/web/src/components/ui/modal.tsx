import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  label?: string;
}

export function Modal({ isOpen, onClose, children, className, size = 'md', label = 'Card details' }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!isOpen || !dialog.current) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
    full: 'max-w-[95vw]',
  };

  return (
    <dialog ref={dialog} aria-label={label}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      className={cn('m-auto w-[calc(100%_-_2rem)] max-h-[90dvh] overflow-y-auto rounded-2xl border border-nebula/30 bg-cosmic-teal/95 p-0 text-starlight shadow-2xl backdrop:bg-black/80 backdrop:backdrop-blur-sm', sizes[size], className)}>
      {isOpen ? children : null}
    </dialog>
  );
}

interface ModalHeaderProps {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}

export function ModalHeader({ children, onClose, className }: ModalHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between p-6 border-b border-nebula/20', className)}>
      <h2 className="text-2xl font-bold gradient-text">{children}</h2>
      {onClose && (
        <button
          onClick={onClose}
          className="text-starlight/60 hover:text-starlight text-2xl leading-none p-1"
        >
          &times;
        </button>
      )}
    </div>
  );
}

interface ModalBodyProps {
  children: ReactNode;
  className?: string;
}

export function ModalBody({ children, className }: ModalBodyProps) {
  return (
    <div className={cn('p-6', className)}>
      {children}
    </div>
  );
}

interface ModalFooterProps {
  children: ReactNode;
  className?: string;
}

export function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div className={cn('flex items-center justify-end gap-3 p-6 border-t border-nebula/20', className)}>
      {children}
    </div>
  );
}
