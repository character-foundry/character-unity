import type { CSSProperties, ImgHTMLAttributes } from 'react';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string; fill?: boolean; priority?: boolean; unoptimized?: boolean; quality?: number };

/** next/image stand-in: a plain lazy image; `fill` covers the positioned parent. */
export default function Image({ fill, priority, style, ...props }: Props) {
  const { unoptimized, quality, sizes, ...rest } = props;
  void unoptimized; void quality; void sizes;
  const fillStyle: CSSProperties = fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%' } : {};
  return <img loading={priority ? 'eager' : 'lazy'} decoding="async" style={{ ...fillStyle, ...style }} {...rest} />;
}
