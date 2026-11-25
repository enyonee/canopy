// A transition (`states`) or a row action (`actions` with `in`) as a button. One with `fields` asks for them in a
// dialog first; a transition that undoes something (cancel, reject…) asks for a confirmation.
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { endpoints } from '@/gen/endpoints';
import type { Action, Entity, Transition } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { EntityForm } from '@/components/entity-form';
import { rowName } from '@/lib/rows';
import { useRun } from '@/lib/run';
import type { Viewer } from '@/lib/perms';
import { enumLabel } from '@/lib/format';

export type Step = { kind: 'go'; t: Transition } | { kind: 'do'; a: Action };

export function StepButton({ entity, row, step, viewer, size = 'default', variant }: { entity: Entity; row: Row; step: Step; viewer: Viewer; size?: 'default' | 'sm'; variant?: 'default' | 'outline' | 'secondary' | 'destructive' }) {
  const run = useRun();
  const [open, setOpen] = useState(false);
  const name = step.kind === 'go' ? step.t.name : step.a.name;
  const label = step.kind === 'go' ? step.t.title : step.a.title;
  const fields = step.kind === 'go' ? step.t.fields : step.a.fields;
  const after = step.kind === 'go' ? step.t.after : step.a.after;
  const destructive = step.kind === 'go' && step.t.destructive;
  const api = endpoints.entities[entity.name];
  const post = (body: Record<string, string | number | boolean | null>) => (step.kind === 'go' ? api.go[name] : api.action[name])(row.id, body);
  const go = (body = {}) => run.mutateAsync({ go: () => post(body), opts: { after, row, inline: fields.length > 0 } });
  const v = variant ?? (destructive ? 'outline' : step.kind === 'go' ? 'default' : 'secondary');
  const busy = run.isPending;
  const name_ = rowName(entity, row);
  const button = (onClick?: () => void) => (
    <Button size={size} variant={v} onClick={onClick} disabled={busy} className={destructive ? 'text-destructive hover:text-destructive' : undefined} data-step={name}>
      {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
      {label}
    </Button>
  );

  if (fields.length) {
    return (
      <>
        {button(() => setOpen(true))}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription>{name_}{step.kind === 'go' ? ` → ${enumLabel(step.t.to)}` : ''}</DialogDescription>
            </DialogHeader>
            <EntityForm entity={entity} names={fields} row={row} viewer={viewer} submit={label} allRequired compact onCancel={() => setOpen(false)}
              onSubmit={async (body) => { await go(body); setOpen(false); }} />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  if (destructive) {
    return (
      <>
        {button(() => setOpen(true))}
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{label}?</AlertDialogTitle>
              <AlertDialogDescription>{name_} will move to “{enumLabel(step.t.to)}”.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => { void go().catch(() => undefined); }}>{label}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
  return button(() => { void go().catch(() => undefined); });
}
