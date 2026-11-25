// One row (`/Entity/:id`): its fields, its status and the steps it offers now, and the related tables the graph
// declares (`detail.related`) with their own row actions and inline add form.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Check, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity, Related } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { ErrorState, EmptyState } from '@/components/states';
import { Guard } from '@/components/guard';
import { FieldValue, StatusBadge } from '@/components/field-value';
import { DataTable, columnField } from '@/components/data-table';
import { EntityForm } from '@/components/entity-form';
import { StepButton, type Step } from '@/components/step-button';
import { DeleteDialog, rowSteps, signInSteps, SignInButton } from '@/components/row-actions';
import { ProductCover, StockChip } from '@/screens/list-screen';
import { stockField } from '@/lib/visual';
import { useRefLabel } from '@/lib/refs';
import { rowName } from '@/lib/rows';
import { can, ownField, transitionsFor, type Viewer } from '@/lib/perms';
import { useViewer } from '@/lib/session';
import { useRun } from '@/lib/run';
import { enumLabel, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

// The statuses a row passes through when nothing goes wrong, in the enum's order; where it stands among them.
function Progress({ entity, row }: { entity: Entity; row: Row }) {
  const st = entity.states!;
  const field = entity.fields.find((f) => f.name === st.field);
  const bad = new Set(st.transitions.filter((t) => t.destructive).map((t) => t.to));
  const path = (field?.options ?? []).filter((o) => !bad.has(o));
  const current = String(row[st.field] ?? '');
  const at = path.indexOf(current);
  if (path.length < 3 || at < 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3 text-sm" aria-label="Progress">
      {path.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === at ? 'step' : undefined}>
          <span className={cn('flex size-6 items-center justify-center rounded-full border text-xs font-semibold',
            i < at && 'border-primary bg-primary text-primary-foreground', i === at && 'border-primary text-primary ring-4 ring-primary/15', i > at && 'text-muted-foreground')}>
            {i < at ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
          </span>
          <span className={cn(i === at ? 'font-medium' : 'text-muted-foreground')}>{enumLabel(s)}</span>
          {i < path.length - 1 && <span className={cn('h-px w-6 sm:w-10', i < at ? 'bg-primary' : 'bg-border')} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function RelatedSection({ parent, row, rel, viewer }: { parent: Entity; row: Row; rel: Related; viewer: Viewer }) {
  const child = app.entities[rel.entity];
  const fetch = endpoints.entities[parent.name].related[rel.entity];
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | null>(null);
  const run = useRun();
  const data = useQuery({ queryKey: ['related', parent.name, row.id, rel.entity, page], queryFn: () => fetch!(row.id, { page }), enabled: Boolean(fetch) });
  const columns = (rel.columns ?? child.list.columns).filter((c) => c !== rel.via);
  const formNames = rel.form === false ? null : (rel.form ?? child.form.fields).filter((n) => n !== rel.via && n !== ownField(viewer, child.name));
  const mayAdd = formNames && formNames.length > 0 && can(viewer, child.name, 'create') && Boolean(endpoints.entities[parent.name].add[rel.entity]);
  const editNames = child.form.byRole[viewer.role ?? ''] ?? child.form.fields;
  const total = data.data?.total ?? 0;
  return (
    <Card className="gap-0 overflow-clip pb-0">
      <CardHeader className="border-b pb-4">
        <CardTitle className="flex items-center gap-2">{rel.title}{data.data && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">{formatNumber(total)}</span>}</CardTitle>
      </CardHeader>
      {!fetch ? (
        <p className="p-6 text-sm text-muted-foreground">The contract of this app offers no way to read these related records.</p>
      ) : data.isError ? <div className="p-4"><ErrorState error={data.error} retry={() => void data.refetch()} /></div>
        : data.isPending ? <DataTable entity={child} rows={[]} columns={columns} rowActions={rel.rowActions} viewer={viewer} caption={rel.title} loading />
        : data.data.rows.length === 0 ? <div className="p-4"><EmptyState title={`No ${rel.title.toLowerCase()} yet`} /></div>
        : <DataTable entity={child} rows={data.data.rows} columns={columns} rowActions={rel.rowActions} viewer={viewer} caption={rel.title} onEdit={setEditing} />}
      {data.data && data.data.pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={page >= data.data.pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      {mayAdd && (
        <div className="border-t bg-muted/30 p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-medium">{rel.submit}</h3>
          <EntityForm entity={child} names={formNames!} viewer={viewer} submit={rel.submit} autoFocus={false}
            onSubmit={(body) => run.mutateAsync({ go: () => endpoints.entities[parent.name].add[rel.entity](row.id, body), opts: { inline: true } })} />
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {child.label.toLowerCase()}</DialogTitle>
            <DialogDescription>{editing ? rowName(child, editing) : ''}</DialogDescription>
          </DialogHeader>
          {editing && (
            <EntityForm entity={child} names={editNames} row={editing} viewer={viewer} submit="Save changes" compact onCancel={() => setEditing(null)}
              onSubmit={async (body) => { await run.mutateAsync({ go: () => endpoints.entities[child.name].update(editing.id, body), opts: { inline: true } }); setEditing(null); }} />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DetailBody({ entity }: { entity: Entity }) {
  const { id } = useParams({ strict: false }) as { id: string };
  const viewer = useViewer();
  const [deleting, setDeleting] = useState(false);
  const data = useQuery({ queryKey: ['row', entity.name, Number(id)], queryFn: () => endpoints.entities[entity.name].get(Number(id)) });
  const listVisible = !entity.list.hidden && can(viewer, entity.name, 'view');
  const crumbs = [{ label: entity.list.title, to: listVisible ? `/${entity.name}` : undefined }];
  if (data.isError) return <ErrorState error={data.error} retry={() => void data.refetch()} />;
  if (data.isPending) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-4 w-32" /><Skeleton className="h-9 w-72" />
        <Card><CardContent className="grid gap-6 sm:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10" />)}</CardContent></Card>
      </div>
    );
  }
  const row = data.data;
  const st = entity.states;
  const steps: Step[] = [
    ...transitionsFor(viewer, entity, row).map((t) => ({ kind: 'go' as const, t })),
    ...rowSteps(entity, row, entity.detail.actions, viewer),
  ];
  const mayEdit = can(viewer, entity.name, 'edit', row);
  const mayDelete = can(viewer, entity.name, 'delete', row);
  const fields = entity.detail.fields.filter((n) => n !== st?.field);
  if (entity.surface === 'storefront') {
    return <StorefrontDetail entity={entity} row={row} viewer={viewer} steps={steps} mayEdit={mayEdit} mayDelete={mayDelete} onDelete={() => setDeleting(true)} crumbs={crumbs}
      deleting={<>{mayDelete && <DeleteDialog entity={entity} row={row} open={deleting} onOpenChange={setDeleting} after={listVisible ? `/${entity.name}` : '/'} />}</>} />;
  }
  return (
    <>
      <PageHeader
        crumbs={[...crumbs, { label: rowName(entity, row) }]}
        title={rowName(entity, row)}
        meta={st ? <StatusBadge entity={entity} value={String(row[st.field] ?? '')} /> : undefined}
        actions={
          <>
            {steps.map((s) => <StepButton key={s.kind === 'go' ? `go:${s.t.name}` : s.a.name} entity={entity} row={row} step={s} viewer={viewer} />)}
            {signInSteps(entity, entity.detail.actions, viewer).map((a) => <SignInButton key={a.name} title={a.title} size="default" />)}
            {mayEdit && <Button asChild variant="outline"><Link to={`/${entity.name}/${row.id}/edit`}><Pencil />Edit</Link></Button>}
            {mayDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      {mayDelete && <DeleteDialog entity={entity} row={row} open={deleting} onOpenChange={setDeleting} after={listVisible ? `/${entity.name}` : '/'} />}
      <div className="grid gap-6">
        {st && <Progress entity={entity} row={row} />}
        <Card>
          <CardHeader><CardTitle>Details</CardTitle><CardDescription>{entity.label} #{row.id}</CardDescription></CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((n) => {
                const f = columnField(entity, n);
                const long = f?.kind === 'longtext';
                return (
                  <div key={n} className={cn('min-w-0 space-y-1', long && 'sm:col-span-2 lg:col-span-3')}>
                    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{f?.label ?? n}</dt>
                    <dd className={cn('text-sm', long ? 'whitespace-pre-line' : 'truncate')}>{n === 'id' ? `#${row.id}` : <FieldValue entity={entity} field={f} row={row} viewer={viewer} labels={entity.detail.labels[n]} />}</dd>
                  </div>
                );
              })}
            </dl>
          </CardContent>
        </Card>
        {entity.detail.related.filter((r) => can(viewer, r.entity, 'view')).map((r) => <RelatedSection key={r.entity + r.via} parent={entity} row={row} rel={r} viewer={viewer} />)}
        {listVisible && <div><Button asChild variant="ghost"><Link to={`/${entity.name}`}><ArrowLeft />Back to {entity.list.title.toLowerCase()}</Link></Button></div>}
      </div>
    </>
  );
}

// A storefront record (a product): its picture or generated cover (a gallery when it has several pictures), the
// price and the action up front, the description, then the remaining details.
function StorefrontDetail({ entity, row, viewer, steps, mayEdit, mayDelete, onDelete, crumbs, deleting }: {
  entity: Entity; row: Row; viewer: Viewer; steps: Step[]; mayEdit: boolean; mayDelete: boolean; onDelete: () => void;
  crumbs: { label: string; to?: string }[]; deleting: React.ReactNode;
}) {
  const refLabel = useRefLabel();
  const images = entity.fields.filter((f) => f.kind === 'image' && row[f.name]);
  const [shown, setShown] = useState(0);
  const price = entity.detail.fields.map((n) => entity.fields.find((f) => f.name === n)).find((f) => f?.kind === 'money');
  const about = entity.fields.find((f) => f.kind === 'longtext');
  const cat = entity.fields.find((f) => f.kind === 'ref' && entity.detail.fields.includes(f.name));
  const catLabel = cat ? refLabel(row, cat.name, cat.target!, viewer) : null;
  const stock = stockField(entity);
  // A shopper is not shown the shop's own switches (a bool such as "active") unless the detail names them for display.
  const rest = entity.detail.fields.filter((n) => ![price?.name, about?.name, entity.labelField].includes(n)
    && !['image', 'bool'].includes(entity.fields.find((f) => f.name === n)?.kind ?? '') && n !== 'id');
  const signIn = signInSteps(entity, entity.detail.actions, viewer);
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted-foreground">
        <ol className="flex items-center gap-1">
          {crumbs.map((c, i) => <li key={i}>{c.to ? <Link to={c.to} className="hover:text-foreground">{c.label}</Link> : c.label}<span aria-hidden="true" className="px-1">/</span></li>)}
          <li aria-current="page" className="text-foreground">{rowName(entity, row)}</li>
        </ol>
      </nav>
      {deleting}
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="space-y-3">
          {images.length > 0 ? (
            <>
              <img src={`/file/${entity.name}/${row.id}/${images[shown].name}`} alt={`${rowName(entity, row)}: ${images[shown].label}`} className="aspect-[4/3] w-full rounded-3xl border object-cover shadow-md" />
              {images.length > 1 && (
                <div className="flex gap-3" role="group" aria-label="Pictures">
                  {images.map((f, i) => (
                    <button key={f.name} type="button" aria-pressed={i === shown} aria-label={f.label} onClick={() => setShown(i)}
                      className={cn('overflow-hidden rounded-xl border-2', i === shown ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100')}>
                      <img src={`/file/${entity.name}/${row.id}/${f.name}`} alt="" className="size-20 object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : <ProductCover entity={entity} row={row} category={catLabel} size="lg" className="aspect-[4/3] w-full rounded-3xl shadow-md" />}
        </div>
        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            {catLabel && <span className="inline-flex rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{catLabel}</span>}
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{rowName(entity, row)}</h1>
            {price && <p className="text-3xl font-semibold tracking-tight tabular-nums"><FieldValue entity={entity} field={price} row={row} viewer={viewer} /></p>}
            {stock && <StockChip value={row[stock.name]} />}
          </div>
          {(steps.length > 0 || signIn.length > 0 || mayEdit || mayDelete) && (
            <div className="flex flex-wrap items-center gap-3">
              {steps.map((s) => <StepButton key={s.kind === 'go' ? `go:${s.t.name}` : s.a.name} entity={entity} row={row} step={s} viewer={viewer} />)}
              {signIn.map((a) => <SignInButton key={a.name} title={a.title} size="default" />)}
              {mayEdit && <Button asChild variant="outline"><Link to={`/${entity.name}/${row.id}/edit`}><Pencil />Edit</Link></Button>}
              {mayDelete && <Button variant="ghost" className="text-destructive" onClick={onDelete}><Trash2 />Delete</Button>}
            </div>
          )}
          {about && row[about.name] ? (
            <section aria-labelledby="about-title" className="border-t pt-6">
              <h2 id="about-title" className="mb-2 text-sm font-semibold">{about.label}</h2>
              <p className="text-base leading-relaxed whitespace-pre-line text-muted-foreground">{String(row[about.name])}</p>
            </section>
          ) : null}
          {rest.length > 0 && (
            <section aria-labelledby="details-title" className="border-t pt-6">
              <h2 id="details-title" className="mb-3 text-sm font-semibold">Details</h2>
              <dl className="divide-y text-sm">
                {rest.map((n) => {
                  const f = columnField(entity, n);
                  return (
                    <div key={n} className="flex items-center justify-between gap-4 py-2.5">
                      <dt className="text-muted-foreground">{f?.label ?? n}</dt>
                      <dd className="text-right font-medium"><FieldValue entity={entity} field={f} row={row} viewer={viewer} labels={entity.detail.labels[n]} /></dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}
        </div>
      </div>
      <div className="mt-10 grid gap-6">
        {entity.detail.related.filter((r) => can(viewer, r.entity, 'view')).map((r) => <RelatedSection key={r.entity + r.via} parent={entity} row={row} rel={r} viewer={viewer} />)}
      </div>
    </>
  );
}

export function DetailScreen({ entity }: { entity: string }) {
  const e = app.entities[entity];
  return <Guard allow={(v) => can(v, entity, 'view')}><DetailBody entity={e} /></Guard>;
}
