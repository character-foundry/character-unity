'use client';

import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils/cn';

// Type guards for extensions
export interface WyvernExtensions {
  depth_prompt?: {
    prompt: string;
    depth: number;
  };
  visual_description?: string;
}

export interface ChubExtensions {
  id?: string;
  full_path?: string;
  custom_css?: string;
}

export type CardExtensions = WyvernExtensions & ChubExtensions;

// Render embedded images in text (base64 and http URLs)
// Options: centered = center images, halfSize = 50% width/height
// Note: External images should already be rewritten to our hosted WebP copies at upload time
// by processCardImages(). This function just renders whatever URLs are in the content.
export function renderTextWithImages(
  text: string,
  options?: { centered?: boolean; halfSize?: boolean }
): React.ReactNode {
  const { centered = false, halfSize = false } = options || {};

  // Match markdown images ![alt](url) and HTML <img> tags with any src (data:, http://, https://)
  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/g;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = imgRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={lastIndex}>{text.slice(lastIndex, match.index)}</span>
      );
    }

    const src = match[2] || match[3];
    const imageClasses = cn(
      'h-auto rounded-lg',
      halfSize ? 'max-w-[50%] max-h-[50vh]' : 'max-w-full'
    );
    const wrapperClasses = cn(
      'block my-4',
      centered && 'flex justify-center'
    );

    parts.push(
      <span key={match.index} className={wrapperClasses}>
        <img
          src={src}
          alt={match[1] || 'Embedded image'}
          className={imageClasses}
        />
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={lastIndex}>{text.slice(lastIndex)}</span>);
  }

  return parts.length > 0 ? parts : text;
}

// Safely render HTML content with XSS sanitization
// Note: External images should already be rewritten to our hosted WebP copies at upload time
// by processCardImages(). This function just renders whatever URLs are in the content.
export function HtmlContent({ html, className }: { html: string; className?: string }) {
  // Sanitize HTML to prevent XSS attacks
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'img',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'code', 'pre', 'span', 'div', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      // 'style', // REMOVED - CSS must be extracted separately to prevent XSS
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'class', 'style', 'target', 'rel',
      'width', 'height', 'data-*',
    ],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button'],
    FORBID_ATTR: ['onclick', 'onerror', 'onload', 'onmouseover', 'onmouseout', 'onfocus', 'onblur'],
    ALLOW_DATA_ATTR: true,
  });

  return (
    <div
      className={cn('prose prose-invert max-w-none', className)}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
