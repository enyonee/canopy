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

type Tone = 'success' | 'destructive' | 'muted' | 'info' | 'warning';

// The tone of a status: where its state machine says it ends well, badly, or not yet.
export function statusTone(entity: Entity, value: string): Tone {
  const st = entity.states;
  if (/cancel|reject|fail|declin|refund|lost|block|error/i.test(value)) return 'destructive';
  if (/deliver|done|complete|paid|approv|won|resolv|closed|success|active/i.test(value)) return 'success';
  if (st) {
    const field = entity.fields.find((f) => f.name === st.field);
    if (field?.default === value) return 'muted';
    const outgoing = st.transitions.some((t) => !t.from || t.from.includes(value));
    if (!outgoing) return 'success';
  }
  if (/pending|wait|review|hold/i.test(value)) return 'warning';
  return 'info';
}

export function StatusBadge({ entity, value }: { entity: Entity; value: string }) {
  return (
    <Badge variant={statusTone(entity, value)} className="status" data-status={value}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {enumLabel(value)}
    </Badge>
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
