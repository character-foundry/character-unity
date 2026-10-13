import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { AppShell } from '@/components/layout';
import { cn } from '@/lib/utils/cn';
import { useSettings } from '@/lib/settings';
import { useCardTags } from '@/lib/library-search';
import { TagPicker } from '@/components/search/tag-picker';
import { ChatAppsSettings } from '@/components/chat/chat-apps-settings';
import { ArchiveSettings } from '@/components/archive/archive-settings';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="glass scroll-mt-20 rounded-xl border border-nebula/20 p-4">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-starlight/40">{title}</h2>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-nebula/30" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
          className={cn('px-3 py-1.5 text-sm', value === option.value ? 'bg-nebula/30 text-nebula' : 'text-starlight/70 hover:bg-cosmic-teal/30')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const { settings, updateSettings } = useSettings();
  const tags = useCardTags();
  const { hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView(); }, [hash]);
  const nsfw = settings.hideNsfw ? 'hide' : settings.blurNsfwContent ? 'blur' : 'show';
  const row = 'flex flex-wrap items-center justify-between gap-3 py-2';

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4">
        <Section id="display" title="Display">
          <div className="divide-y divide-nebula/10 text-sm">
            <div className={row}>
              <span>NSFW cards</span>
              <Segmented label="NSFW cards" value={nsfw} onChange={(value) => updateSettings({ hideNsfw: value === 'hide', blurNsfwContent: value !== 'show' })}
                options={[{ value: 'show', label: 'Show' }, { value: 'blur', label: 'Blur' }, { value: 'hide', label: 'Hide' }]} />
            </div>
            <label className={cn(row, 'cursor-pointer')}>
              <span>Show images in greetings</span>
              <input type="checkbox" checked={settings.showImagesInGreetings} onChange={(event) => updateSettings({ showImagesInGreetings: event.target.checked })} />
            </label>
          </div>
        </Section>
        <Section id="hidden-tags" title="Hidden tags">
          <TagPicker label="Cards with any of these tags never show up in the library or search" tone="hidden" value={settings.bannedTags}
            options={tags} onChange={(bannedTags) => updateSettings({ bannedTags })} placeholder="Add tag" />
        </Section>
        <Section id="archive" title="Archive sources">
          <ArchiveSettings />
        </Section>
        <Section id="chat-apps" title="Chat apps">
          <ChatAppsSettings />
        </Section>
      </div>
    </AppShell>
  );
}
