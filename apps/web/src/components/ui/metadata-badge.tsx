'use client';

import { cn } from '@/lib/utils/cn';
import { ChatIcon, BookIcon, ImageIcon, FolderIcon } from './icons';

type MetadataType = 'greetings' | 'lorebook' | 'images' | 'assets';

interface MetadataBadgeProps {
  type: MetadataType;
  count: number;
  /** 'compact' = icon + count only (for grid), 'full' = icon + count + label (for modal/full page) */
  variant?: 'compact' | 'full';
  className?: string;
}

const CONFIG: Record<MetadataType, {
  icon: typeof ChatIcon;
  label: string;
  labelSingular: string;
  bgClass: string;
  textClass: string;
}> = {
  greetings: {
    icon: ChatIcon,
    label: 'Greetings',
    labelSingular: 'Greeting',
    bgClass: 'bg-blue-500/20',
    textClass: 'text-blue-400',
  },
  lorebook: {
    icon: BookIcon,
    label: 'Lorebook',
    labelSingular: 'Lorebook',
    bgClass: 'bg-emerald-500/20',
    textClass: 'text-emerald-400',
  },
  images: {
    icon: ImageIcon,
    label: 'Images',
    labelSingular: 'Image',
    bgClass: 'bg-amber-500/20',
    textClass: 'text-amber-400',
  },
  assets: {
    icon: FolderIcon,
    label: 'Assets',
    labelSingular: 'Asset',
    bgClass: 'bg-purple-500/20',
    textClass: 'text-purple-400',
  },
};

export function MetadataBadge({ type, count, variant = 'compact', className }: MetadataBadgeProps) {
  if (count <= 0) return null;

  const config = CONFIG[type];
  const Icon = config.icon;
  const label = count === 1 ? config.labelSingular : config.label;

  if (variant === 'compact') {
    // Grid view: icon + count in dark pill
    return (
      <div
        className={cn(
          'flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-black/60 text-xs text-starlight/80',
          className
        )}
        title={`${count} ${label}`}
      >
        <Icon className="w-3 h-3" />
        <span>{count}</span>
      </div>
    );
  }

  // Full view: icon + count + label in colored pill
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        config.bgClass,
        config.textClass,
        className
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{count} {label}</span>
    </span>
  );
}
