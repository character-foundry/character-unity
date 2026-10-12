import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { Link as RouterLink } from 'react-router';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean };

/** next/link stand-in over react-router. External and download links stay plain anchors. */
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, replace, ...props }, ref) {
  const { prefetch, scroll, ...rest } = props;
  void prefetch; void scroll;
  if (/^[a-z]+:/i.test(href) || rest.download !== undefined) return <a ref={ref} href={href} {...rest} />;
  return <RouterLink ref={ref} to={href} replace={replace} {...rest} />;
});
export default Link;
