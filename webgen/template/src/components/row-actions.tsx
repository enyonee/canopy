// The buttons of one row, as `rowActions` (or `detail.actions`) name them: declared actions and transitions as
// buttons, open/edit/delete in a menu, each offered only where the viewer may use it.
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Eye, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { endpoints } from '@/gen/endpoints';
import type { Entity } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { StepButton, type Step } from '@/components/step-button';
import { can, mayRunAction, transitionsFor, type Viewer } from '@/lib/perms';
import { useRun } from '@/lib/run';
import { rowName } from '@/lib/rows';


/** The declared steps of a row the viewer may take now. */
export function rowSteps(entity: Entity, row: Row, names: readonly string[], viewer: Viewer): Step[] {
  const open = transitionsFor(viewer, entity, row);
  return names.flatMap((n): Step[] => {
    if (n.startsWith('go:')) {
      const t = open.find((x) => x.name === n.slice(3));
      return t ? [{ kind: 'go' as const, t }] : [];
    }
    const a = entity.actions.find((x) => x.name === n);
    return a && mayRunAction(viewer, entity.name, a, row) ? [{ kind: 'do' as const, a }] : [];
  });
}

export function DeleteDialog({ entity, row, open, onOpenChange, after }: { entity: Entity; row: Row; open: boolean; onOpenChange: (o: boolean) => void; after?: string }) {
  const run = useRun();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {rowName(entity, row)}?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => { void run.mutateAsync({ go: () => endpoints.entities[entity.name].remove(row.id), opts: { after: after ?? null } }).catch(() => undefined); }}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RowActions({ entity, row, names, viewer, onEdit }: { entity: Entity; row: Row; names: readonly string[]; viewer: Viewer; onEdit?: (row: Row) => void }) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const steps = rowSteps(entity, row, names, viewer);
  const view = names.includes('view') && can(viewer, entity.name, 'view', row);
  const edit = names.includes('edit') && can(viewer, entity.name, 'edit', row);
  const del = names.includes('delete') && can(viewer, entity.name, 'delete', row);
  const name = rowName(entity, row);
  return (
    <div className="flex items-center justify-end gap-1.5">
      {steps.map((s) => <StepButton key={s.kind === 'go' ? `go:${s.t.name}` : s.a.name} entity={entity} row={row} step={s} viewer={viewer} size="sm" variant={s.kind === 'do' ? 'default' : 'outline'} />)}
      {(view || edit || del) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {view && <DropdownMenuItem onSelect={() => void navigate({ to: `/${entity.name}/${row.id}` })}><Eye />Open</DropdownMenuItem>}
            {edit && <DropdownMenuItem onSelect={() => (onEdit ? onEdit(row) : void navigate({ to: `/${entity.name}/${row.id}/edit` }))}><Pencil />Edit</DropdownMenuItem>}
            {del && (view || edit) && <DropdownMenuSeparator />}
            {del && <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}><Trash2 />Delete</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {del && <DeleteDialog entity={entity} row={row} open={deleting} onOpenChange={setDeleting} />}
    </div>
  );
}
