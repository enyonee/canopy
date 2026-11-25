// A record whose related rows point at storefront rows (an order and its lines, a cart): a list of lines with their
// pictures 8/12 and a sticky summary 4/12 with the totals and the next step. The shape is read from the graph: the
// related child has a reference to a storefront entity; the summary is the parent's money fields.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Minus, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity, Field, Related } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorState } from '@/components/states';
import { FieldValue, StatusBadge } from '@/components/field-value';
import { EntityForm } from '@/components/entity-form';
import { StepButton, type Step } from '@/components/step-button';
import { DeleteDialog } from '@/components/row-actions';
import { Cover } from '@/components/cover';
import { columnField } from '@/components/data-table';
import { rowName } from '@/lib/rows';
import { can, type Viewer } from '@/lib/perms';
import { useRefLabel } from '@/lib/refs';
import { useRun } from '@/lib/run';
import { enumLabel, formatDate, formatMoney } from '@/lib/format';
import { iconWord } from '@/lib/visual';
import { cn } from '@/lib/utils';

/** The related table of an entity whose rows are lines of storefront rows, if it has one. */
export function lineItems(entity: Entity): { rel: Related; product: Field } | null {
  for (const rel of entity.detail.related) {
    const product = app.entities[rel.entity]?.fields.find((f) => f.kind === 'ref' && f.target && app.entities[f.target]?.surface === 'storefront');
    if (product) return { rel, product };
  }
  return null;
}

// Where the record stands on its happy path: done steps checked, the current one marked, the rest grey. The initial
// status (a cart) is left out once the record has moved on from it.
export function Stepper({ entity, row }: { entity: Entity; row: Row }) {
  const st = entity.states;
  if (!st) return null;
  const field = entity.fields.find((f) => f.name === st.field);
  const bad = new Set(st.transitions.filter((t) => t.destructive).map((t) => t.to));
  const current = String(row[st.field] ?? '');
  const path = (field?.options ?? []).filter((o) => !bad.has(o) && (o !== field?.default || current === field?.default));
  const at = path.indexOf(current);
  if (path.length < 3 || at < 0) return null;
  return (
    <ol className="grid gap-3 sm:flex sm:items-center sm:gap-0" aria-label="Progress">
      {path.map((s, i) => (
        <li key={s} className="flex items-center gap-2.5 sm:flex-1" aria-current={i === at ? 'step' : undefined}>
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
            i < at && 'border-primary bg-primary text-primary-foreground', i === at && 'border-primary text-accent-text', i > at && 'border-border text-muted-foreground')}>
            {i < at ? <Check className="size-4" aria-hidden="true" /> : i + 1}
          </span>
          <span className={cn('text-sm whitespace-nowrap', i === at ? 'font-semibold' : i < at ? 'text-foreground' : 'text-muted-foreground')}>
            {enumLabel(s)}{i < at && <span className="sr-only"> (done)</span>}
          </span>
          {i < path.length - 1 && <span className={cn('mx-3 hidden h-0.5 flex-1 rounded sm:block', i < at ? 'bg-primary' : 'bg-border')} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function Lines({ parent, row, rel, product, viewer }: { parent: Entity; row: Row; rel: Related; product: Field; viewer: Viewer }) {
  const child = app.entities[rel.entity];
  const fetch = endpoints.entities[parent.name].related[rel.entity];
  const refLabel = useRefLabel();
  const run = useRun();
  const [editing, setEditing] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const data = useQuery({ queryKey: ['related', parent.name, row.id, rel.entity, 1], queryFn: () => fetch!(row.id, { page: 1 }), enabled: Boolean(fetch) });
  const columns = (rel.columns ?? child.list.columns).filter((c) => c !== rel.via && c !== product.name);
  const money = columns.map((c) => child.fields.find((f) => f.name === c)).filter((f): f is Field => f?.kind === 'money');
  const line = money[money.length - 1];
  const unit = money.length > 1 ? money[0] : null;
  const editNames = child.form.byRole[viewer.role ?? ''] ?? child.form.fields;
  // A quantity stepper when the line's only editable field is a whole number.
  const qty = editNames.length === 1 ? child.fields.find((f) => f.name === editNames[0] && f.type === 'integer') : undefined;
  // The quantity is a stepper while the parent is still in its first status (a cart); afterwards it reads as text.
  const st = parent.states;
  const draft = !st || String(row[st.field] ?? '') === (parent.fields.find((f) => f.name === st.field)?.default ?? '');
  if (!fetch) return <p className="text-sm text-muted-foreground">The contract of this app offers no way to read these lines.</p>;
  if (data.isError) return <ErrorState error={data.error} retry={() => void data.refetch()} />;
  if (data.isPending) return <div className="space-y-4" aria-busy="true">{[0, 1].map((i) => <div key={i} className="flex gap-4"><Skeleton className="size-20 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-1/4" /></div></div>)}</div>;
  if (!data.data.rows.length) return <EmptyState title={`No ${rel.title.toLowerCase()} yet`} />;
  return (
    <>
      <ul className="divide-y" aria-label={rel.title}>
        {data.data.rows.map((r) => {
          const label = refLabel(r, product.name, product.target!, viewer) ?? '';
          const edit = rel.rowActions.includes('edit') && can(viewer, child.name, 'edit', r);
          const del = rel.rowActions.includes('delete') && can(viewer, child.name, 'delete', r);
          const n = qty ? Number(r[qty.name] ?? 0) : 0;
          const setQty = (v: number) => void run.mutateAsync({ go: () => endpoints.entities[child.name].update(r.id, { [qty!.name]: v }), opts: { quiet: true } }).catch(() => undefined);
          return (
            <li key={r.id} data-row-id={r.id} className="flex gap-4 py-4 first:pt-0">
              <Cover name={label} icon={iconWord(label)} size="sm" className="size-20 shrink-0 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  {can(viewer, product.target!, 'view') ? <Link to={`/${product.target}/${String(r[product.name])}`} className="font-medium hover:text-accent-text">{label}</Link> : <p className="font-medium">{label}</p>}
                  {unit && <p className="text-sm text-muted-foreground tabular-nums">{formatMoney(r[unit.name])} each</p>}
                  {columns.filter((c) => !money.some((m) => m.name === c) && c !== qty?.name).map((c) => {
                    const f = columnField(child, c);
                    return <p key={c} className="text-sm text-muted-foreground">{f?.label}: <FieldValue entity={child} field={f} row={r} viewer={viewer} /></p>;
                  })}
                </div>
                <div className="flex items-center gap-4">
                  {qty && (edit && draft ? (
                    <div className="flex items-center rounded-lg border" role="group" aria-label={`${qty.label} of ${label}`}>
                      <Button variant="ghost" size="icon-sm" aria-label={`One less ${label}`} disabled={run.isPending || n <= 1} onClick={() => setQty(n - 1)}><Minus /></Button>
                      <span className="w-8 text-center text-sm font-medium tabular-nums" aria-live="polite">{n}</span>
                      <Button variant="ghost" size="icon-sm" aria-label={`One more ${label}`} disabled={run.isPending} onClick={() => setQty(n + 1)}><Plus /></Button>
                    </div>
                  ) : <span className="text-sm text-muted-foreground tabular-nums">× {n}</span>)}
                  {line && <p className="w-20 text-right font-semibold tabular-nums"><FieldValue entity={child} field={line} row={r} viewer={viewer} /></p>}
                  {(edit || del) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More for ${rowName(child, r)}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {edit && <DropdownMenuItem onSelect={() => setEditing(r)}><Pencil />Edit</DropdownMenuItem>}
                        {del && <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(r)}><Trash2 />Remove</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit {child.label.toLowerCase()}</DialogTitle><DialogDescription>{editing ? refLabel(editing, product.name, product.target!, viewer) : ''}</DialogDescription></DialogHeader>
          {editing && <EntityForm entity={child} names={editNames} row={editing} viewer={viewer} submit="Save changes" compact onCancel={() => setEditing(null)}
            onSubmit={async (body) => { await run.mutateAsync({ go: () => endpoints.entities[child.name].update(editing.id, body), opts: { inline: true } }); setEditing(null); }} />}
        </DialogContent>
      </Dialog>
      {deleting && <DeleteDialog entity={child} row={deleting} open onOpenChange={(o) => !o && setDeleting(null)} />}
    </>
  );
}

export function OrderLayout({ entity, row, viewer, steps, rel, product, header, extra }: {
  entity: Entity; row: Row; viewer: Viewer; steps: Step[]; rel: Related; product: Field; header: React.ReactNode; extra: React.ReactNode;
}) {
  const st = entity.states;
  const moneyFields = entity.detail.fields.map((n) => entity.fields.find((f) => f.name === n)).filter((f): f is Field => f?.kind === 'money');
  // Equal amounts are one line (a net equal to the total): the last money field is what is to pay.
  const summary = moneyFields.filter((f, i) => i === moneyFields.length - 1 || Number(row[f.name]) !== Number(row[moneyFields[moneyFields.length - 1].name]));
  const time = entity.fields.find((f) => f.kind === 'time' && entity.detail.fields.includes(f.name));
  const facts = entity.detail.fields.filter((n) => n !== st?.field && !moneyFields.some((m) => m.name === n) && n !== time?.name && n !== 'id'
    && entity.fields.find((f) => f.name === n)?.kind !== 'int'
    && row[n] !== null && row[n] !== undefined && row[n] !== ''
    // the viewer's own name on their own order says nothing
    && !(entity.fields.find((f) => f.name === n)?.target === app.roles?.entity && viewer.user && String(row[n]) === String(viewer.user.id)));
  const [main, ...more] = steps.filter((s) => !(s.kind === 'go' && s.t.destructive));
  const undo = steps.filter((s) => s.kind === 'go' && s.t.destructive);
  return (
    <>
      {header}
      <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        {st && <StatusBadge entity={entity} value={String(row[st.field] ?? '')} />}
        {time && row[time.name] ? <span>{time.label} {formatDate(row[time.name], 'time')}</span> : null}
      </div>
      <div className="grid gap-8 lg:grid-cols-12">
        <div className="space-y-8 lg:col-span-8">
          {st && <div className="rounded-xl border bg-card p-5 shadow-xs"><Stepper entity={entity} row={row} /></div>}
          <section aria-labelledby="lines-title" className="rounded-xl border bg-card p-5 shadow-xs">
            <h2 id="lines-title" className="mb-4 text-lg font-semibold">{rel.title}</h2>
            <Lines parent={entity} row={row} rel={rel} product={product} viewer={viewer} />
          </section>
          {extra}
        </div>
        <aside className="lg:col-span-4" aria-label="Summary">
          <div className="space-y-5 rounded-xl border bg-card p-5 shadow-xs lg:sticky lg:top-24">
            <h2 className="text-lg font-semibold">Summary</h2>
            <dl className="space-y-2 text-sm">
              {summary.map((f, i) => (
                <div key={f.name} className={cn('flex justify-between gap-4', i === summary.length - 1 && 'border-t pt-3 text-xl font-semibold')}>
                  <dt className={cn(i !== summary.length - 1 && 'text-muted-foreground')}>{f.label}</dt>
                  <dd className="tabular-nums"><FieldValue entity={entity} field={f} row={row} viewer={viewer} /></dd>
                </div>
              ))}
            </dl>
            {facts.length > 0 && (
              <dl className="space-y-2 border-t pt-4 text-sm">
                {facts.map((n) => {
                  const f = columnField(entity, n);
                  return (
                    <div key={n} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{f?.label ?? n}</dt>
                      <dd className="min-w-0 truncate text-right"><FieldValue entity={entity} field={f} row={row} viewer={viewer} labels={entity.detail.labels[n]} /></dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {(main || undo.length > 0) && (
              <div className="space-y-2 border-t pt-4">
                {main && <StepButton entity={entity} row={row} step={main} viewer={viewer} size="lg" variant="default" className="h-12 w-full text-base" />}
                {more.map((s) => <StepButton key={s.kind === 'go' ? s.t.name : s.a.name} entity={entity} row={row} step={s} viewer={viewer} variant="outline" className="w-full" />)}
                {undo.map((s) => <StepButton key={s.kind === 'go' ? s.t.name : ''} entity={entity} row={row} step={s} viewer={viewer} variant="outline" className="w-full" />)}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
