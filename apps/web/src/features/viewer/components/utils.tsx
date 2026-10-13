import { createContext, useContext, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils/cn';
import { safeImageSource } from '../media';

const ViewMedia = createContext<Record<string, string>>({});
export const ViewMediaProvider = ViewMedia.Provider;

export function RenderTextWithImages({ text, centered = false, halfSize = false }: { text: string; centered?: boolean; halfSize?: boolean }) {
  const resources = useContext(ViewMedia);
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/g;
  const parts: ReactNode[] = [];
  let position = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > position) parts.push(<span key={position}>{text.slice(position, match.index)}</span>);
    const src = safeImageSource(match[2] || match[3], resources);
    parts.push(src ? <span key={match.index} className={cn('my-4 block', centered && 'flex justify-center')}><img src={src} alt={match[1] || 'Embedded image'} loading="lazy"
      className={cn('h-auto rounded-lg', halfSize ? 'max-h-[50vh] max-w-[50%]' : 'max-w-full')} /></span> :
      <span key={match.index} className="text-starlight/50">[Image not stored: {match[1] || 'embedded image'}]</span>);
    position = match.index + match[0].length;
  }
  if (position < text.length) parts.push(<span key={position}>{text.slice(position)}</span>);
  return <>{parts.length ? parts : text}</>;
}

/** Semantic creator markup is allowed; scripts, styles and remote image loads are not. */
export function HtmlContent({ html, className }: { html: string; className?: string }) {
  const resources = useContext(ViewMedia);
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span', 'div', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'width', 'height'],
    ALLOW_DATA_ATTR: false,
  });
  // A template is inert: unresolved images are removed before content reaches the live document.
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  template.content.querySelectorAll('img').forEach((image) => {
    const source = safeImageSource(image.getAttribute('src') ?? '', resources);
    if (source) { image.src = source; image.loading = 'lazy'; image.className = 'max-w-full h-auto rounded-lg'; }
    else { const placeholder = document.createElement('span'); placeholder.textContent = `[Image not stored: ${image.alt || 'embedded image'}]`; image.replaceWith(placeholder); }
  });
  template.content.querySelectorAll('a').forEach((link) => {
    if (/^https?:\/\//i.test(link.getAttribute('href') ?? '')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  return <div className={cn('prose prose-invert max-w-none overflow-x-auto', className)} dangerouslySetInnerHTML={{ __html: template.innerHTML }} />;
}
