import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils/cn';
import { HtmlContent, RenderTextWithImages } from '../utils';

interface NotesSectionProps { creatorNotes: string | null; isNsfw?: boolean }

export function NotesSection({ creatorNotes, isNsfw }: NotesSectionProps) {
  const { settings } = useSettings();
  const blur = settings.blurNsfwContent && isNsfw;
  const html = creatorNotes && /<(p|div|span|br|b|i|u|strong|em|a|img|ul|ol|li|h[1-6]|blockquote|code|pre|hr|table|thead|tbody|tr|th|td)[>\s]/i.test(creatorNotes);
  return <div data-section="notes">
    <h2 className="gradient-text mb-4 text-xl font-semibold" data-section-title>Creator&apos;s Notes</h2>
    {!creatorNotes ? <p className="italic text-starlight/50" data-notes-empty>No creator notes provided.</p> :
      html ? <HtmlContent html={creatorNotes} className={cn('text-starlight/80', blur && 'blur-md select-none')} /> :
        <div className={cn('whitespace-pre-wrap break-words text-starlight/80', blur && 'blur-md select-none')} data-notes-content><RenderTextWithImages text={creatorNotes} /></div>}
  </div>;
}
