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
import { statusTone, toneVars } from '@/lib/visual';
import { Avatar } from '@/components/avatar';

export function StatusBadge({ entity, value }: { entity: Entity; value: string }) {
  const t = toneVars(statusTone(entity, value));
  return (
    <span className="status inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap" style={{ background: t.bg, color: t.fg }} data-status={value}>
      <span className="size-1.5 rounded-full" style={{ background: t.dot }} aria-hidden="true" />
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
        ? <Link to={`/${field.target}/${String(v)}`} className="relative z-10 font-medium text-accent-text underline-offset-4 hover:underline">{text}</Link> : <span>{text}</span>;
      return <span className={cn('inline-flex items-center gap-2', className)}>{person}{label}</span>;
    }
    return target && can(viewer, field.target, 'view') ? (
      <Link to={`/${field.target}/${String(v)}`} className={cn('font-medium text-accent-text underline-offset-4 hover:underline', className)}>{text}</Link>
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
