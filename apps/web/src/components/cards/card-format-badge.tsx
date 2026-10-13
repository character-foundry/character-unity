import type { SourceFormat } from '@/types/card';
import { cn } from '@/lib/utils/cn';

export function CardFormatBadge({ format, specVersion }: { format: SourceFormat | null; specVersion: string }) {
  const label = format === 'charx' || format === 'voxta' ? format : specVersion;
  return <span className={cn('rounded px-2 py-0.5 text-xs font-semibold uppercase text-white',
    format === 'charx' ? 'bg-amber-500/80' : format === 'voxta' ? 'bg-purple-500/80' : specVersion === 'v3' ? 'bg-emerald-500/80' : 'bg-blue-500/80')}>{label}</span>;
}
