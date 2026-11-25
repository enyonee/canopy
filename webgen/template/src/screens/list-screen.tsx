// A list: an entity's own (`/Entity`) or a saved one (`/list/<id>`). Search, filters, sorting and the page live in
// the URL, so a list can be shared and the back button works; the server narrows, scopes and pages every query.
// A storefront entity (webgen's heuristic, README) is drawn by screens/storefront.tsx; the rest is a workspace table.
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity } from '@/lib/model';
import type { Page, Query, Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Sort } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Guard } from '@/components/guard';
import { can, canSee, type Viewer } from '@/lib/perms';
import { useViewer } from '@/lib/session';
import { useOptions } from '@/lib/refs';
import { enumLabel, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { StorefrontList } from '@/screens/storefront';

export type Spec = {
  key: string; title: string; intro: string | null; entity: Entity; columns: readonly string[]; rowActions: readonly string[];
  search: readonly string[]; filters: readonly { name: string; field: string; range: boolean }[]; create: boolean; createTitle: string;
  labels: Readonly<Record<string, readonly string[]>>; fetch: (q: Query) => Promise<Page>;
  roles: readonly string[] | null; pageSize: number;
};

const ALL = '__all__';

/** The choices a filter offers: the rows of a referenced entity, an enum's values, yes/no. */
export function useFilterChoices(entity: Entity, field: string, viewer: Viewer) {
  const f = entity.fields.find((x) => x.name === field);
  const options = useOptions(f?.kind === 'ref' ? f.target : null, viewer);
  if (f?.kind === 'ref') return (options.data ?? []).map((o) => ({ value: o.id, label: o.label }));
  if (f?.kind === 'enum') return (f.options ?? []).map((o) => ({ value: o, label: enumLabel(o) }));
  if (f?.kind === 'bool') return [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }];
  return [];
}

function FilterSelect({ entity, filter, value, onChange, viewer }: { entity: Entity; filter: { name: string; field: string }; value: string; onChange: (v: string) => void; viewer: Viewer }) {
  const choices = useFilterChoices(entity, filter.field, viewer);
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger id={`filter_${filter.field}`} aria-label={filter.name} className={cn('h-9 w-auto min-w-36 gap-2', value && 'border-primary/40 bg-accent')}>
        <span className="text-muted-foreground">{filter.name}:</span><SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All</SelectItem>
        {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** The state of a list in the URL, and its page from the server: shared by the workspace table and the storefront. */
export function useListState(spec: Spec) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | number | undefined>;
  const q = String(search.q ?? '');
  const page = Number(search.page ?? 1) || 1;
  const sort: Sort = search.sort ? { field: String(search.sort), dir: search.dir === 'desc' ? 'desc' : 'asc' } : null;
  const filters = Object.fromEntries(spec.filters.flatMap((f) => (f.range ? [`${f.field}_from`, `${f.field}_to`] : [f.field])).map((k) => [k, String(search[k] ?? '')]));
  const [text, setText] = useState(q);
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
  const clear = () => { setText(''); set(Object.fromEntries([...Object.keys(filters), 'q', 'page'].map((k) => [k, undefined]))); };
  const createButton = mayCreate ? <Button asChild><Link to={`/${spec.entity.name}/new`}><Plus />{spec.createTitle}</Link></Button> : null;
  return { viewer, search, q, text, setText, page, sort, filters, set, query, data, narrowed, mayCreate, clear, createButton };
}

/** "1–10 of 128" and the page buttons; nothing to page through, only the count. */
export function Pager({ page, pages, total, shown, size, onPage, className }: { page: number; pages: number; total: number; shown: number; size: number; onPage: (p: number) => void; className?: string }) {
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const range = total === 0 ? 'No records' : pages > 1 ? `${formatNumber(first)}–${formatNumber(first + shown - 1)} of ${formatNumber(total)}` : `${formatNumber(total)} ${total === 1 ? 'record' : 'records'}`;
  return (
    <div className={cn('flex flex-col items-center justify-between gap-3 py-3 text-sm text-muted-foreground sm:flex-row', className)}>
      <p aria-live="polite" className="tabular-nums">{range}</p>
      {pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft />Previous</Button>
          <span className="px-2 tabular-nums">{page} / {pages}</span>
          <Button variant="outline" size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">Next<ChevronRight /></Button>
        </nav>
      )}
    </div>
  );
}

// The toolbar of a workspace list: the search box and the filters in one row, applied filters highlighted, one "Clear".
function Toolbar({ spec, s }: { spec: Spec; s: ReturnType<typeof useListState> }) {
  if (!spec.search.length && !spec.filters.length) return null;
  return (
    <div role="search" className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:flex-wrap sm:items-center">
      {spec.search.length > 0 && (
        <div className="relative sm:w-72">
          <label htmlFor="list-search" className="sr-only">Search {spec.title.toLowerCase()}</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input id="list-search" type="search" value={s.text} onChange={(e) => s.setText(e.target.value)} placeholder={`Search ${spec.title.toLowerCase()}…`} className="h-9 pl-9" />
        </div>
      )}
      {spec.filters.filter((f) => !f.range).map((f) => (
        <FilterSelect key={f.field} entity={spec.entity} filter={f} value={s.filters[f.field]} viewer={s.viewer} onChange={(v) => s.set({ [f.field]: v, page: undefined })} />
      ))}
      {spec.filters.filter((f) => f.range).map((f) => (
        <fieldset key={f.field} className="flex items-center gap-2">
          <legend className="sr-only">{f.name}</legend>
          <span className="text-sm text-muted-foreground">{f.name}</span>
          <Input aria-label={`${f.name} from`} type="date" value={s.filters[`${f.field}_from`]} onChange={(e) => s.set({ [`${f.field}_from`]: e.target.value, page: undefined })} className="h-9 w-40" />
          <Input aria-label={`${f.name} to`} type="date" value={s.filters[`${f.field}_to`]} onChange={(e) => s.set({ [`${f.field}_to`]: e.target.value, page: undefined })} className="h-9 w-40" />
        </fieldset>
      ))}
      {s.narrowed && <Button variant="ghost" size="sm" onClick={s.clear}><X />Clear</Button>}
    </div>
  );
}

function ListBody({ spec }: { spec: Spec }) {
  const s = useListState(spec);
  const { viewer, data, sort, set } = s;
  const onSort = (field: string) => set({ sort: field, dir: sort?.field === field && sort.dir === 'asc' ? 'desc' : 'asc', page: undefined });
  return (
    <>
      <PageHeader title={spec.title} description={spec.intro ?? undefined} actions={s.createButton} />
      <Card className="gap-0 overflow-clip py-0" aria-busy={data.isFetching || undefined}>
        <Toolbar spec={spec} s={s} />
        {data.isError ? <div className="p-4"><ErrorState error={data.error} retry={() => void data.refetch()} /></div>
          : data.isPending ? <DataTable entity={spec.entity} rows={[]} columns={spec.columns} rowActions={spec.rowActions} viewer={viewer} caption={spec.title} loading />
          : data.data.rows.length === 0 ? (
            <div className="p-4">
              {s.narrowed ? <EmptyState searching title="No matches" description="Nothing matches this search or filter." action={<Button variant="outline" onClick={s.clear}>Clear filters</Button>} />
                : <EmptyState title={`No ${spec.title.toLowerCase()} yet`} description={s.mayCreate ? 'Create the first one to get started.' : 'There is nothing to show here yet.'} action={s.createButton} />}
            </div>
          ) : (
            <>
              <DataTable entity={spec.entity} rows={data.data.rows} columns={spec.columns} rowActions={spec.rowActions} viewer={viewer} labels={spec.labels} sort={sort} onSort={onSort} caption={spec.title} />
              <Pager className="border-t px-4" page={data.data.page} pages={data.data.pages} total={data.data.total} shown={data.data.rows.length} size={spec.pageSize} onPage={(p) => set({ page: p })} />
            </>
          )}
      </Card>
    </>
  );
}

// A storefront entity's own list is the catalogue; its table view (?view=table) and saved lists stay workspace tables.
function Chooser({ spec }: { spec: Spec }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  if (spec.entity.surface === 'storefront' && !spec.key.startsWith('list:') && search.view !== 'table') return <StorefrontList spec={spec} />;
  return <ListBody spec={spec} />;
}

export function EntityListScreen({ entity }: { entity: string }) {
  const e = app.entities[entity];
  const spec: Spec = { key: entity, title: e.list.title, intro: e.list.intro, entity: e, columns: e.list.columns, rowActions: e.list.rowActions, search: e.list.search,
    filters: e.list.filters, create: e.list.create, createTitle: e.list.createTitle, labels: e.list.labels, fetch: (q) => endpoints.entities[entity].list(q), roles: null, pageSize: e.list.pageSize };
  return <Guard allow={(v) => can(v, entity, 'view')}><Chooser key={spec.key} spec={spec} /></Guard>;
}

export function SavedListScreen({ id }: { id: string }) {
  const l = app.lists.find((x) => x.id === id)!;
  const e = app.entities[l.entity];
  const spec: Spec = { key: `list:${id}`, title: l.title, intro: l.intro, entity: e, columns: l.columns, rowActions: l.rowActions, search: l.search, filters: [],
    create: l.create, createTitle: l.createTitle, labels: e.list.labels, fetch: (q) => endpoints.lists[id](q), roles: l.roles, pageSize: 50 };
  return <Guard allow={(v) => canSee(v, l.roles) && can(v, l.entity, 'view')}><Chooser key={spec.key} spec={spec} /></Guard>;
}

export type { Row };
