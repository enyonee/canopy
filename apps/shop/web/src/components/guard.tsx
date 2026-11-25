// A screen the viewer may not open: a visitor is sent to sign in (and comes back), anyone else sees "No access".
import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useViewer } from '@/lib/session';
import { Forbidden } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import type { Viewer } from '@/lib/perms';

export function Guard({ allow, children }: { allow: (v: Viewer) => boolean; children: ReactNode }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const ok = !viewer.loading && allow(viewer);
  const toLogin = !viewer.loading && !ok && !viewer.user;
  // Sent once, with the address the visitor asked for: while the route changes this guard may render again.
  const sent = useRef(false);
  useEffect(() => {
    if (!toLogin || sent.current || href.startsWith('/login')) return;
    sent.current = true;
    void navigate({ to: '/login', search: { next: href }, replace: true });
  }, [toLogin, href, navigate]);
  if (viewer.loading || toLogin) return <div className="space-y-4" aria-busy="true"><Skeleton className="h-9 w-56" /><Skeleton className="h-64 w-full" /></div>;
  if (!ok) return <Forbidden />;
  return <>{children}</>;
}
