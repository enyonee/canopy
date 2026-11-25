// A list: an entity's own (`/Entity`) or a saved one (`/list/<id>`). Search, filters, sorting and the page live in
// the URL, so a list can be shared and the back button works; the server narrows, scopes and pages every query.
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, LayoutGrid, Plus, Rows3, Search, X } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity, Field } from '@/lib/model';
import type { Query, Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type Sort } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Guard } from '@/components/guard';
import { FieldValue } from '@/components/field-value';
import { RowActions } from '@/components/row-actions';
import { rowName } from '@/lib/rows';
import { can, canSee, type Viewer } from '@/lib/perms';
import { useViewer } from '@/lib/session';
import { useOptions } from '@/lib/refs';
import { enumLabel, formatNumber } from '@/lib/format';

type Spec = {
  key: string; title: string; intro: string | null; entity: Entity; columns: readonly string[]; rowActions: readonly string[];
  search: readonly string[]; filters: readonly { name: string; field: string; range: boolean }[]; create: boolean; createTitle: string;
  labels: Readonly<Record<string, readonly string[]>>; fetch: (q: Query) => Promise<{ rows: Row[]; total: number; page: number; pages: number }>;
  roles: readonly string[] | null;
};

const ALL = '__all__';

function FilterSelect({ entity, filter, value, onChange, viewer }: { entity: Entity; filter: { name: string; field: string }; value: string; onChange: (v: string) => void; viewer: Viewer }) {
  const f = entity.fields.find((x) => x.name === filter.field);
  const options = useOptions(f?.kind === 'ref' ? f.target : null, viewer);
  const choices = f?.kind === 'ref' ? (options.data ?? []).map((o) => ({ value: o.id, label: o.label }))
    : f?.kind === 'enum' ? (f.options ?? []).map((o) => ({ value: o, label: enumLabel(o) }))
    : f?.kind === 'bool' ? [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] : [];
  const id = `filter_${filter.field}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{filter.name}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
        <SelectTrigger id={id} className="w-full sm:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

// A catalogue reads better as cards: a list whose rows carry a declared action and a description.
const catalogue = (spec: Spec) => spec.rowActions.some((a) => spec.entity.actions.some((x) => x.name === a)) && spec.entity.fields.some((f) => f.kind === 'longtext');

function CatalogueGrid({ spec, rows, viewer }: { spec: Spec; rows: Row[]; viewer: Viewer }) {
  const e = spec.entity;
  const about = e.fields.find((f) => f.kind === 'longtext');
  const price = spec.columns.map((c) => e.fields.find((f) => f.name === c)).find((f) => f?.kind === 'money');
  const meta = spec.columns.map((c) => e.fields.find((f) => f.name === c)).filter((f): f is Field => Boolean(f) && f!.name !== e.labelField && f !== price);
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={spec.title}>
      {rows.map((r) => (
        <li key={r.id} data-row-id={r.id}>
          <Card className="group relative h-full gap-4 overflow-hidden pt-0 pb-5 transition-shadow hover:shadow-md">
            <div className="flex h-28 items-center justify-center bg-gradient-to-br from-primary/15 via-primary/5 to-transparent" aria-hidden="true">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-card text-2xl font-semibold text-primary shadow-sm ring-1 ring-primary/10 transition-transform group-hover:scale-105">{rowName(e, r).slice(0, 1).toUpperCase()}</span>
            </div>
            <div className="flex items-start justify-between gap-3 px-5">
              <div className="min-w-0 space-y-1">
                <h3 className="truncate font-semibold">
                  {can(viewer, e.name, 'view', r) ? <Link to={`/${e.name}/${r.id}`} className="after:absolute hover:text-primary">{rowName(e, r)}</Link> : rowName(e, r)}
                </h3>
                {about && r[about.name] ? <p className="line-clamp-2 text-sm text-muted-foreground">{String(r[about.name])}</p> : null}
              </div>
              {price && <p className="shrink-0 text-lg font-semibold tabular-nums"><FieldValue entity={e} field={price} row={r} viewer={viewer} /></p>}
            </div>
            {meta.length > 0 && (
              <dl className="flex flex-wrap gap-x-5 gap-y-1 px-5 text-sm">
                {meta.map((f) => (
                  <div key={f.name} className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd><FieldValue entity={e} field={f} row={r} viewer={viewer} labels={spec.labels[f.name]} /></dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-auto flex justify-end px-5"><RowActions entity={e} row={r} names={spec.rowActions} viewer={viewer} /></div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Pager({ page, pages, total, shown, onPage }: { page: number; pages: number; total: number; shown: number; onPage: (p: number) => void }) {
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row">
      <p aria-live="polite">{total === 0 ? 'No records' : `${formatNumber(total)} ${total === 1 ? 'record' : 'records'}${pages > 1 ? ` · page ${page} of ${pages}` : ''}`}<span className="sr-only">, {shown} shown</span></p>
      {pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft />Previous</Button>
          <Button variant="outline" size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">Next<ChevronRight /></Button>
        </nav>
      )}
    </div>
  );
}

function ListBody({ spec }: { spec: Spec }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | number | undefined>;
  const q = String(search.q ?? '');
  const page = Number(search.page ?? 1) || 1;
  const sort: Sort = search.sort ? { field: String(search.sort), dir: search.dir === 'desc' ? 'desc' : 'asc' } : null;
  const filters = Object.fromEntries(spec.filters.flatMap((f) => (f.range ? [`${f.field}_from`, `${f.field}_to`] : [f.field])).map((k) => [k, String(search[k] ?? '')]));
  const [text, setText] = useState(q);
  const grid = catalogue(spec) && search.view !== 'table';

  const set = (patch: Record<string, string | number | undefined>) =>
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...prev, ...patch };
      for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined) delete next[k];
      return next;
    }, replace: true });

  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => set({ q: text, page: undefined }), 300);
    return () => clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const query: Query = { page, q: q || undefined, sort: sort?.field, dir: sort?.dir, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
  const data = useQuery({ queryKey: ['list', spec.key, query], queryFn: () => spec.fetch(query), placeholderData: keepPreviousData });
  const narrowed = Boolean(q) || Object.values(filters).some(Boolean);
  const mayCreate = spec.create && can(viewer, spec.entity.name, 'create');
  const onSort = (field: string) => set({ sort: field, dir: sort?.field === field && sort.dir === 'asc' ? 'desc' : 'asc', page: undefined });
  const createButton = mayCreate ? <Button asChild><Link to={`/${spec.entity.name}/new`}><Plus />{spec.createTitle}</Link></Button> : null;

  return (
    <>
      <PageHeader title={spec.title} description={spec.intro ?? undefined} actions={createButton} />
      {(spec.search.length > 0 || spec.filters.length > 0 || catalogue(spec)) && (
        <div role="search" className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          {spec.search.length > 0 && (
            <div className="grid flex-1 gap-1.5 sm:max-w-sm">
              <Label htmlFor="list-search" className="text-xs text-muted-foreground">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="list-search" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Search ${spec.title.toLowerCase()}…`} className="pl-9" />
              </div>
            </div>
          )}
          {spec.filters.filter((f) => !f.range).map((f) => (
            <FilterSelect key={f.field} entity={spec.entity} filter={f} value={filters[f.field]} viewer={viewer} onChange={(v) => set({ [f.field]: v, page: undefined })} />
          ))}
          {spec.filters.filter((f) => f.range).map((f) => (
            <fieldset key={f.field} className="grid gap-1.5">
              <legend className="mb-1.5 text-xs text-muted-foreground">{f.name}</legend>
              <div className="flex gap-2">
                <Input aria-label={`${f.name} from`} type="date" value={filters[`${f.field}_from`]} onChange={(e) => set({ [`${f.field}_from`]: e.target.value, page: undefined })} className="w-40" />
                <Input aria-label={`${f.name} to`} type="date" value={filters[`${f.field}_to`]} onChange={(e) => set({ [`${f.field}_to`]: e.target.value, page: undefined })} className="w-40" />
              </div>
            </fieldset>
          ))}
          {narrowed && <Button variant="ghost" onClick={() => { setText(''); set(Object.fromEntries([...Object.keys(filters), 'q', 'page'].map((k) => [k, undefined]))); }}><X />Clear</Button>}
          {catalogue(spec) && (
            <div className="flex items-center gap-1 rounded-lg border bg-card p-0.5 sm:ml-auto" role="group" aria-label="Layout">
              <Button variant={grid ? 'secondary' : 'ghost'} size="icon-sm" aria-pressed={grid} aria-label="Cards" onClick={() => set({ view: undefined })}><LayoutGrid /></Button>
              <Button variant={!grid ? 'secondary' : 'ghost'} size="icon-sm" aria-pressed={!grid} aria-label="Table" onClick={() => set({ view: 'table' })}><Rows3 /></Button>
            </div>
          )}
        </div>
      )}
      {data.isError ? <ErrorState error={data.error} retry={() => void data.refetch()} />
        : data.isPending ? (grid
          ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
          : <Card className="py-0"><DataTable entity={spec.entity} rows={[]} columns={spec.columns} rowActions={spec.rowActions} viewer={viewer} caption={spec.title} loading /></Card>)
        : data.data.rows.length === 0 ? (
          narrowed ? <EmptyState searching title="No matches" description="Nothing matches this search or filter. Try another word or clear the filters." />
            : <EmptyState title={`No ${spec.title.toLowerCase()} yet`} description={mayCreate ? 'Create the first one to get started.' : 'There is nothing to show here yet.'} action={createButton} />
        ) : grid ? (
          <div className="space-y-4" aria-busy={data.isFetching || undefined}>
            <CatalogueGrid spec={spec} rows={data.data.rows} viewer={viewer} />
            <Card className="py-0"><Pager page={data.data.page} pages={data.data.pages} total={data.data.total} shown={data.data.rows.length} onPage={(p) => set({ page: p })} /></Card>
          </div>
        ) : (
          <Card className="gap-0 overflow-hidden py-0" aria-busy={data.isFetching || undefined}>
            <DataTable entity={spec.entity} rows={data.data.rows} columns={spec.columns} rowActions={spec.rowActions} viewer={viewer} labels={spec.labels} sort={sort} onSort={onSort} caption={spec.title} />
            <Pager page={data.data.page} pages={data.data.pages} total={data.data.total} shown={data.data.rows.length} onPage={(p) => set({ page: p })} />
          </Card>
        )}
    </>
  );
}

export function EntityListScreen({ entity }: { entity: string }) {
  const e = app.entities[entity];
  const spec: Spec = { key: entity, title: e.list.title, intro: e.list.intro, entity: e, columns: e.list.columns, rowActions: e.list.rowActions, search: e.list.search,
    filters: e.list.filters, create: e.list.create, createTitle: e.list.createTitle, labels: e.list.labels, fetch: (q) => endpoints.entities[entity].list(q), roles: null };
  return <Guard allow={(v) => can(v, entity, 'view')}><ListBody key={spec.key} spec={spec} /></Guard>;
}

export function SavedListScreen({ id }: { id: string }) {
  const l = app.lists.find((x) => x.id === id)!;
  const e = app.entities[l.entity];
  const spec: Spec = { key: `list:${id}`, title: l.title, intro: l.intro, entity: e, columns: l.columns, rowActions: l.rowActions, search: l.search, filters: [],
    create: l.create, createTitle: l.createTitle, labels: e.list.labels, fetch: (q) => endpoints.lists[id](q), roles: l.roles };
  return <Guard allow={(v) => canSee(v, l.roles) && can(v, l.entity, 'view')}><ListBody key={spec.key} spec={spec} /></Guard>;
}
