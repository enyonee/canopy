// Every write the screens make: post, toast the server's `flash`, refresh what it may have changed, and follow the
// graph's `after` path. A refusal (400 validation, 403, 409 wrong state) is shown in the server's own words.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ApiError, type Row, type Saved } from '@/lib/api';
import { fillPath, inApp } from '@/lib/paths';

export type RunOpts = { after?: string | null; row?: Row; success?: string; quiet?: boolean; inline?: boolean };

export function errorTitle(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Not allowed';
    if (e.status === 409) return 'Not available right now';
    if (e.status === 400) return 'Please check the details';
    if (e.status === 404) return 'Not found';
    if (e.status === 0) return 'Offline';
  }
  return 'Something went wrong';
}

export function toastError(e: unknown) {
  const msg = e instanceof ApiError ? e.errors.join(' · ') : e instanceof Error ? e.message : String(e);
  toast.error(errorTitle(e), { description: msg });
}

export function useRun() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({ go }: { go: () => Promise<Saved | { ok: true; flash: string; id?: number; created?: number }>; opts?: RunOpts }) => go(),
    onSuccess: async (res, { opts }) => {
      if (!opts?.quiet) toast.success(res.flash || opts?.success || 'Saved');
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      const after = opts?.after && inApp(fillPath(opts.after, ('row' in res && res.row) || opts.row, { id: res.id ?? opts.row?.id, created: res.created }));
      if (after) await navigate({ to: after });
    },
    // A form shows its own 400 next to the fields; anything else is a toast.
    onError: (e, { opts }) => { if (!(opts?.inline && e instanceof ApiError && e.status === 400)) toastError(e); },
  });
}
