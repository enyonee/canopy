// Empty, failed, forbidden and missing: what a screen shows when there is nothing (or nothing for you) to show.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { EmptyBoxArt, LockArt, SearchArt } from '@/components/illustrations';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';

export function EmptyState({ title, description, action, searching }: { title: string; description?: string; action?: ReactNode; searching?: boolean }) {
  const Art = searching ? SearchArt : EmptyBoxArt;
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed bg-card/60 px-6 py-14 text-center">
      <Art />
      <div className="space-y-1.5">
        <p className="text-lg font-semibold">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <Forbidden />;
  if (error instanceof ApiError && error.status === 404) return <NotFound what={error.errors[0]} />;
  const msg = error instanceof ApiError ? error.errors.join(' · ') : error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center">
      <AlertTriangle className="size-8 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">This could not be loaded</p>
        <p className="text-sm text-muted-foreground">{msg}</p>
      </div>
      {retry && <Button variant="outline" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <LockArt />
      <h1 className="text-2xl font-semibold">No access</h1>
      <p className="text-muted-foreground">Your account does not have permission to open this page.</p>
      <Button asChild variant="outline"><Link to="/">Go to the start page</Link></Button>
    </div>
  );
}

export function NotFound({ what }: { what?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <p className="text-6xl font-semibold tracking-tight text-accent-text/40" aria-hidden="true">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">{what ?? 'The page you are looking for does not exist or was moved.'}</p>
      <Button asChild variant="outline"><Link to="/">Go to the start page</Link></Button>
    </div>
  );
}
