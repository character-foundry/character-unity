import { useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from 'react-router';

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    refresh: () => navigate(0),
  }), [navigate]);
}
export function usePathname() { return useLocation().pathname; }
export function useSearchParams() { return useRouterSearchParams()[0]; }
export function notFound(): never { throw new Error('Not found'); }
