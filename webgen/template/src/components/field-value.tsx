// One value of a row on screen, by its field's kind: a status badge, money, a yes/no, a link to the referenced row.
import { Link } from '@tanstack/react-router';
import { Check, Minus } from 'lucide-react';
import { app } from '@/gen/app';
import type { Entity, Field } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { plainValue, enumLabel } from '@/lib/format';
import { can, mayReadField, type Viewer } from '@/lib/perms';
import { useRefLabel } from '@/lib/refs';
import { cn } from '@/lib/utils';
import { statusTone, type Tone } from '@/lib/visual';
import { Avatar } from '@/components/avatar';

// Status colours: one hue per step of the state machine, by order (lib/visual.ts), readable in light and dark.
const TONES: Record<Tone, string> = {
  slate: 'bg-slate-500/12 text-slate-700 ring-slate-500/20 dark:text-slate-300',
  sky: 'bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:text-sky-300',
  violet: 'bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:text-violet-300',
  amber: 'bg-amber-500/15 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
  indigo: 'bg-indigo-500/12 text-indigo-700 ring-indigo-500/25 dark:text-indigo-300',
  fuchsia: 'bg-fuchsia-500/12 text-fuchsia-700 ring-fuchsia-500/25 dark:text-fuchsia-300',
  emerald: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
  rose: 'bg-rose-500/12 text-rose-700 ring-rose-500/25 dark:text-rose-300',
};

export function StatusBadge({ entity, value }: { entity: Entity; value: string }) {
  return (
    <span className={cn('status inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONES[statusTone(entity, value)])} data-status={value}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {enumLabel(value)}
    </span>
  );
}

export function FieldValue({ entity, field, row, viewer, labels, className }: { entity: Entity; field: Field | undefined; row: Row; viewer: Viewer; labels?: readonly string[]; className?: string }) {
  const refLabel = useRefLabel();
  if (!field) return <span className={className}>{String(row[field ?? ''] ?? '')}</span>;
  if (!mayReadField(viewer, entity, field.name, row)) return <span className="text-muted-foreground italic">Hidden</span>;
  const v = row[field.name];
  if (v === null || v === undefined || v === '') return <span className="text-muted-foreground/60" aria-label="empty">—</span>;
  if (entity.states?.field === field.name) return <StatusBadge entity={entity} value={String(v)} />;
  if (field.kind === 'ref' && field.target) {
    const text = refLabel(row, field.name, field.target, viewer);
    const target = app.entities[field.target];
    // A reference to a person (the roles entity) reads with their avatar.
    const person = app.roles?.entity === field.target && text ? <Avatar name={text} size="sm" /> : null;
    if (person) {
      const label = target && can(viewer, field.target, 'view')
        ? <Link to={`/${field.target}/${String(v)}`} className="relative z-10 font-medium text-primary underline-offset-4 hover:underline">{text}</Link> : <span>{text}</span>;
      return <span className={cn('inline-flex items-center gap-2', className)}>{person}{label}</span>;
    }
    return target && can(viewer, field.target, 'view') ? (
      <Link to={`/${field.target}/${String(v)}`} className={cn('font-medium text-primary underline-offset-4 hover:underline', className)}>{text}</Link>
    ) : <span className={className}>{text}</span>;
  }
  if (field.kind === 'bool' && !labels) {
    return v ? <span className="inline-flex items-center gap-1 text-success"><Check className="size-4" aria-hidden="true" />Yes</span>
      : <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="size-4" aria-hidden="true" />No</span>;
  }
  if (field.kind === 'enum') return <Badge variant="outline" className={className}>{enumLabel(v)}</Badge>;
  const numeric = field.kind === 'money' || field.type === 'integer' || field.type === 'number';
  return <span className={cn(numeric && 'tabular-nums', field.kind === 'money' && 'font-medium', className)}>{plainValue(field, v, labels)}</span>;
}
