import type { ExportFormat } from '../../lib/unity';

export function tileExportFormats(hasPortrait: boolean): readonly { value: ExportFormat; label: string; hint: string }[] {
  return [
    ...(hasPortrait ? [{ value: 'png' as const, label: 'PNG card', hint: '.png' }] : []),
    { value: 'charx', label: 'CharX archive', hint: '.charx' },
    { value: 'json', label: 'JSON card', hint: '.json' },
    ...(hasPortrait ? [{ value: 'sillytavern-png' as const, label: 'SillyTavern PNG', hint: 'v2' }] : []),
    { value: 'sillytavern-json', label: 'SillyTavern JSON', hint: 'v2' },
  ];
}

export function exportExtension(format: ExportFormat): string {
  return format.endsWith('png') ? 'png' : format === 'charx' ? 'charx' : 'json';
}
