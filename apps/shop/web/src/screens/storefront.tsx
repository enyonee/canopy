// The storefront: what a visitor or a customer browses (webgen's `surface`, README). A catalogue of cards (2/3/4
// columns, 4:5 pictures, name and price on two lines, at most one badge, no button but the card itself and a quick
// "+" for an action the viewer may take), and a product page in two columns with a sticky buy box.
import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { LayoutGrid, Loader2, LogIn, Pencil, Plus, Rows3, Search, Trash2 } from 'lucide-react';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Entity, Field } from '@/lib/model';
import type { Row } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState } from '@/components/states';
import { FieldValue } from '@/components/field-value';
import { Cover } from '@/components/cover';
import { StepButton, type Step } from '@/components/step-button';
import { rowSteps, signInSteps } from '@/components/row-actions';
import { columnField } from '@/components/data-table';
import { rowName } from '@/lib/rows';
import { can, type Viewer } from '@/lib/perms';
import { useRefLabel } from '@/lib/refs';
import { useRun } from '@/lib/run';
import { formatNumber } from '@/lib/format';
import { iconWord, stockField } from '@/lib/visual';
import { cn } from '@/lib/utils';
import { Pager, useFilterChoices, useListState, type Spec } from '@/screens/list-screen';

const categoryOf = (entity: Entity, columns: readonly string[]) =>
  columns.map((c) => entity.fields.find((f) => f.name === c)).find((f) => f?.kind === 'ref') ?? entity.fields.find((f) => f.kind === 'ref') ?? null;

/** The picture of a row: its first image field, else a neutral cover with the icon of its category. */
export function ProductCover({ entity, row, category, className, size }: { entity: Entity; row: Row; category: string | null; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const image = entity.fields.find((f) => f.kind === 'image');
  if (image && row[image.name]) return <img src={`/file/${entity.name}/${row.id}/${image.name}`} alt="" loading="lazy" className={cn('bg-muted object-cover', className)} />;
  return <Cover name={rowName(entity, row)} icon={iconWord(category, rowName(entity, row), entity.name)} className={className} size={size} />;
}

/** Only the exceptions are badges: few left (amber), none left (grey). Being in stock is the normal case. */
export function StockNote({ value, inline }: { value: unknown; inline?: boolean }) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return null;
  if (inline) {
    const tone = n <= 0 ? 'var(--tone-0-dot)' : n <= 3 ? 'var(--warning-dot)' : 'var(--success-dot)';
    return <p className="flex items-center gap-2 text-sm"><span className="size-2 rounded-full" style={{ background: tone }} aria-hidden="true" />{n <= 0 ? 'Out of stock' : n <= 3 ? `Only ${n} left` : 'In stock'}</p>;
  }
  if (n > 3) return null;
  return (
    <span className="rounded-md px-2 py-0.5 text-xs font-medium shadow-xs" style={n <= 0 ? { background: 'var(--tone-0-bg)', color: 'var(--tone-0-fg)' } : { background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
      {n <= 0 ? 'Out of stock' : `Only ${n} left`}
    </span>
  );
}

// The quick action of a card: a declared action without fields the viewer may run (add to cart), as a round "+".
function QuickAdd({ entity, row, step }: { entity: Entity; row: Row; step: Step & { kind: 'do' } }) {
  const run = useRun();
  const name = rowName(entity, row);
  return (
    <button type="button" aria-label={`${step.a.title}: ${name}`} data-step={step.a.name} disabled={run.isPending}
      onClick={() => void run.mutateAsync({ go: () => endpoints.entities[entity.name].action[step.a.name](row.id, {}), opts: { after: step.a.after, row } }).catch(() => undefined)}
      className="absolute right-3 bottom-3 z-10 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition duration-200 ease-snappy hover:scale-105 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 motion-reduce:transition-none">
      {run.isPending ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <Plus className="size-5" aria-hidden="true" />}
    </button>
  );
}

function ProductCard({ spec, row, viewer }: { spec: Spec; row: Row; viewer: Viewer }) {
  const e = spec.entity;
  const refLabel = useRefLabel();
  const name = rowName(e, row);
  const cat = categoryOf(e, spec.columns);
  const catLabel = cat ? refLabel(row, cat.name, cat.target!, viewer) : null;
  const price = spec.columns.map((c) => e.fields.find((f) => f.name === c)).find((f) => f?.kind === 'money');
  const about = e.fields.find((f) => f.kind === 'longtext');
  const stock = stockField(e);
  const soldOut = stock !== null && Number(row[stock.name]) <= 0;
  const quick = rowSteps(e, row, spec.rowActions, viewer).find((s): s is Step & { kind: 'do' } => s.kind === 'do' && s.a.fields.length === 0);
  const open = can(viewer, e.name, 'view', row);
  return (
    <article className={cn('group relative flex flex-col', soldOut && 'opacity-60')} data-row-id={row.id}>
      <div className="relative overflow-hidden rounded-xl transition duration-200 ease-snappy group-hover:-translate-y-0.5 group-hover:shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
        <ProductCover entity={e} row={row} category={catLabel} className="aspect-[4/5] w-full transition-transform duration-300 ease-out group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
        {stock && <div className="absolute top-3 left-3"><StockNote value={row[stock.name]} /></div>}
        {quick && <QuickAdd entity={e} row={row} step={quick} />}
      </div>
      <div className="mt-3 space-y-1">
        {catLabel && <p className="text-xs text-muted-foreground">{catLabel}</p>}
        <h3 className="line-clamp-2 text-[15px] leading-snug font-medium">
          {open ? <Link to={`/${e.name}/${row.id}`} className="after:absolute after:inset-0 focus-visible:outline-none">{name}</Link> : name}
        </h3>
        {about && row[about.name] ? <p className="line-clamp-1 hidden text-sm text-muted-foreground sm:block">{String(row[about.name])}</p> : null}
        {price && <p className="text-base font-semibold tabular-nums"><FieldValue entity={e} field={price} row={row} viewer={viewer} /></p>}
        {stock && spec.columns.includes(stock.name) && <span className="sr-only">{stock.label} {String(row[stock.name])}</span>}
      </div>
    </article>
  );
}

function CardSkeletons() {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-6" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="space-y-3"><Skeleton className="aspect-[4/5] w-full rounded-xl" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/3" /></div>
      ))}
    </div>
  );
}

// Category chips above the grid (up to six choices; more become a select), the active one filled.
function CategoryChips({ spec, field, value, onChange, viewer }: { spec: Spec; field: string; value: string; onChange: (v: string) => void; viewer: Viewer }) {
  const choices = useFilterChoices(spec.entity, field, viewer);
  const label = spec.filters.find((f) => f.field === field)?.name ?? field;
  if (choices.length > 6) {
    return (
      <Select value={value || '__all__'} onValueChange={(v) => onChange(v === '__all__' ? '' : v)}>
        <SelectTrigger aria-label={label} className="h-9 w-auto min-w-40"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">All</SelectItem>{choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
      </Select>
    );
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={`Filter by ${label.toLowerCase()}`}>
      {[{ value: '', label: 'All' }, ...choices].map((c) => (
        <button key={c.value} type="button" aria-pressed={value === c.value} onClick={() => onChange(c.value)}
          className={cn('h-9 rounded-full border px-4 text-sm font-medium transition-colors', value === c.value ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent')}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

// Sort orders a shopper expects, as the list's own ?sort=&dir=.
function SortSelect({ entity, value, onChange }: { entity: Entity; value: string; onChange: (sort?: string, dir?: string) => void }) {
  const price = entity.fields.find((f) => f.kind === 'money' && !f.derived);
  const options = [
    { v: '', label: 'Featured' },
    ...(price ? [{ v: `${price.name}:asc`, label: 'Price: low to high' }, { v: `${price.name}:desc`, label: 'Price: high to low' }] : []),
    ...(entity.labelField ? [{ v: `${entity.labelField}:asc`, label: 'Name: A–Z' }] : []),
    { v: 'id:desc', label: 'Newest' },
  ];
  return (
    <Select value={value || '__'} onValueChange={(v) => { const [s, d] = v === '__' ? [] : v.split(':'); onChange(s, d); }}>
      <SelectTrigger aria-label="Sort" className="h-9 w-auto min-w-44 gap-2"><span className="text-muted-foreground">Sort:</span><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.v || '__'} value={o.v || '__'}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// A front page panel only where it earns its height: the home list of a large catalogue (12+ rows, 4+ categories).
function Hero({ spec, total, categories }: { spec: Spec; total: number; categories: number }) {
  if (!app.hero || app.hero.entity !== spec.entity.name || total < 12 || categories < 4) return null;
  return (
    <section aria-labelledby="hero-title" className="mb-10 rounded-2xl bg-brand-gradient px-6 py-12 text-primary-foreground sm:px-10">
      <p className="text-sm font-medium opacity-80">{app.hero.eyebrow}</p>
      <h2 id="hero-title" className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">{app.hero.title}</h2>
      {app.hero.subtitle && <p className="mt-3 max-w-xl text-lg opacity-90">{app.hero.subtitle}</p>}
    </section>
  );
}

export function StorefrontList({ spec }: { spec: Spec }) {
  const s = useListState(spec);
  const { viewer, data, set } = s;
  const cat = categoryOf(spec.entity, spec.columns);
  const catFilter = spec.filters.find((f) => !f.range && f.field === cat?.name)?.field ?? null;
  const catChoices = useFilterChoices(spec.entity, catFilter ?? '', viewer);
  const staff = can(viewer, spec.entity.name, 'edit') || can(viewer, spec.entity.name, 'create');
  const total = data.data?.total ?? 0;
  const sortValue = s.sort ? `${s.sort.field}:${s.sort.dir}` : '';
  return (
    <>
      <Hero spec={spec} total={total} categories={catChoices.length} />
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{spec.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {data.isPending ? ' ' : `${formatNumber(total)} ${total === 1 ? spec.entity.label.toLowerCase() : spec.entity.plural.toLowerCase()}`}
            {spec.intro ? ` · ${spec.intro}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.createButton}
          {staff && (
            <div className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5" role="group" aria-label="Layout">
              <Button variant="secondary" size="icon-sm" aria-pressed="true" aria-label="Cards"><LayoutGrid /></Button>
              <Button variant="ghost" size="icon-sm" aria-pressed="false" aria-label="Table" onClick={() => set({ view: 'table' })}><Rows3 /></Button>
            </div>
          )}
        </div>
      </div>
      <div role="search" className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {catFilter ? <CategoryChips spec={spec} field={catFilter} value={s.filters[catFilter]} viewer={viewer} onChange={(v) => set({ [catFilter]: v, page: undefined })} /> : <span />}
        <div className="flex flex-wrap items-center gap-2">
          {spec.search.length > 0 && (
            <div className="relative w-full sm:w-64">
              <label htmlFor="list-search" className="sr-only">Search {spec.title.toLowerCase()}</label>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="list-search" type="search" value={s.text} onChange={(ev) => s.setText(ev.target.value)} placeholder={`Search ${spec.title.toLowerCase()}…`} className="h-9 pl-9" />
            </div>
          )}
          <SortSelect entity={spec.entity} value={sortValue} onChange={(sort, dir) => set({ sort, dir, page: undefined })} />
          {s.narrowed && <Button variant="ghost" size="sm" onClick={s.clear}>Clear all</Button>}
        </div>
      </div>
      {data.isError ? <ErrorState error={data.error} retry={() => void data.refetch()} />
        : data.isPending ? <CardSkeletons />
        : data.data.rows.length === 0 ? (
          s.narrowed ? <EmptyState searching title="Nothing found" description="No products match these filters." action={<Button variant="outline" onClick={s.clear}>Reset filters</Button>} />
            : <EmptyState title={`No ${spec.title.toLowerCase()} yet`} description="Come back soon." action={s.createButton} />
        ) : (
          <div aria-busy={data.isFetching || undefined}>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6" aria-label={spec.title}>
              {data.data.rows.map((r) => <li key={r.id}><ProductCard spec={spec} row={r} viewer={viewer} /></li>)}
            </ul>
            {data.data.pages > 1 && <Pager className="mt-8" page={data.data.page} pages={data.data.pages} total={total} shown={data.data.rows.length} size={spec.pageSize} onPage={(p) => set({ page: p })} />}
          </div>
        )}
    </>
  );
}

// ---- the product page -------------------------------------------------------------------------------------------

function SignInCta({ title, className }: { title: string; className?: string }) {
  const href = useRouterState({ select: (st) => st.location.href });
  return <Button asChild size="lg" className={cn('h-12 w-full text-base', className)}><Link to="/login" search={{ next: href }}><LogIn />Sign in to {title.toLowerCase()}</Link></Button>;
}

/** A storefront row's page: gallery 7/12, buy box 5/12 (sticky), description and details in tabs, a mobile buy bar. */
export function StorefrontDetail({ entity, row, viewer, steps, mayEdit, mayDelete, onDelete, crumbs, deleting, related }: {
  entity: Entity; row: Row; viewer: Viewer; steps: Step[]; mayEdit: boolean; mayDelete: boolean; onDelete: () => void;
  crumbs: { label: string; to?: string }[]; deleting: ReactNode; related: ReactNode;
}) {
  const refLabel = useRefLabel();
  const images = entity.fields.filter((f) => f.kind === 'image' && row[f.name]);
  const [shown, setShown] = useState(0);
  const price = entity.fields.find((f) => f.kind === 'money' && entity.detail.fields.includes(f.name));
  const about = entity.fields.find((f) => f.kind === 'longtext');
  const cat = entity.fields.find((f) => f.kind === 'ref' && entity.detail.fields.includes(f.name));
  const catLabel = cat ? refLabel(row, cat.name, cat.target!, viewer) : null;
  const stock = stockField(entity);
  // Details a shopper reads: not the name, price, description or picture shown above, not the shop's own switches.
  const details = entity.detail.fields.filter((n) => ![price?.name, about?.name, entity.labelField, stock?.name, 'id'].includes(n)
    && !['image', 'bool'].includes(entity.fields.find((f) => f.name === n)?.kind ?? ''));
  const signIn = signInSteps(entity, entity.detail.actions, viewer);
  const [main, ...others] = steps;
  const name = rowName(entity, row);
  const cta = main ? <StepButton entity={entity} row={row} step={main} viewer={viewer} size="lg" variant="default" className="h-12 w-full text-base" />
    : signIn[0] ? <SignInCta title={signIn[0].title} /> : null;
  const priceNode = price ? <FieldValue entity={entity} field={price} row={row} viewer={viewer} /> : null;
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-1.5">
          {crumbs.map((c, i) => <li key={i} className="flex items-center gap-1.5">{c.to ? <Link to={c.to} className="hover:text-foreground">{c.label}</Link> : c.label}<span aria-hidden="true">/</span></li>)}
          {catLabel && <li className="flex items-center gap-1.5">{catLabel}<span aria-hidden="true">/</span></li>}
          <li aria-current="page" className="text-foreground">{name}</li>
        </ol>
      </nav>
      {deleting}
      <div className="grid gap-8 pb-24 lg:grid-cols-12 lg:gap-12 lg:pb-0">
        <div className="space-y-3 lg:col-span-7">
          {images.length > 0
            ? <img src={`/file/${entity.name}/${row.id}/${images[shown].name}`} alt={`${name}: ${images[shown].label}`} className="aspect-[4/5] w-full rounded-2xl bg-muted object-cover sm:aspect-square" />
            : <ProductCover entity={entity} row={row} category={catLabel} size="lg" className="aspect-[4/5] w-full rounded-2xl sm:aspect-square" />}
          {images.length > 1 && (
            <div className="flex gap-3" role="group" aria-label="Pictures">
              {images.map((f, i) => (
                <button key={f.name} type="button" aria-pressed={i === shown} aria-label={`Picture ${i + 1} of ${images.length}`} onClick={() => setShown(i)}
                  className={cn('overflow-hidden rounded-lg border-2', i === shown ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100')}>
                  <img src={`/file/${entity.name}/${row.id}/${f.name}`} alt="" className="size-20 object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="lg:col-span-5">
          <div className="space-y-6 lg:sticky lg:top-24">
            <div className="space-y-2">
              {catLabel && <p className="text-sm font-medium text-accent-text">{catLabel}</p>}
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{name}</h1>
              {priceNode && <p className="text-3xl font-semibold tracking-tight tabular-nums">{priceNode}</p>}
            </div>
            {stock && <StockNote value={row[stock.name]} inline />}
            {cta && <div className="hidden space-y-3 lg:block">{cta}{others.map((st) => <StepButton key={st.kind === 'go' ? st.t.name : st.a.name} entity={entity} row={row} step={st} viewer={viewer} variant="outline" className="w-full" />)}</div>}
            {(about || details.length > 0) && (
              <Tabs defaultValue={about && row[about.name] ? 'about' : 'details'} className="border-t pt-6">
                <TabsList>
                  {about && row[about.name] ? <TabsTrigger value="about">{about.label}</TabsTrigger> : null}
                  {details.length > 0 && <TabsTrigger value="details">Details</TabsTrigger>}
                </TabsList>
                {about && row[about.name] ? <TabsContent value="about"><p className="pt-2 leading-relaxed whitespace-pre-line text-muted-foreground">{String(row[about.name])}</p></TabsContent> : null}
                {details.length > 0 && (
                  <TabsContent value="details">
                    <dl className="divide-y text-sm">
                      {details.map((n) => {
                        const f: Field | undefined = columnField(entity, n);
                        return (
                          <div key={n} className="flex justify-between gap-4 py-2.5">
                            <dt className="text-muted-foreground">{f?.label ?? n}</dt>
                            <dd className="text-right font-medium"><FieldValue entity={entity} field={f} row={row} viewer={viewer} labels={entity.detail.labels[n]} /></dd>
                          </div>
                        );
                      })}
                    </dl>
                  </TabsContent>
                )}
              </Tabs>
            )}
            {(mayEdit || mayDelete) && (
              <div className="flex gap-2 border-t pt-4">
                {mayEdit && <Button asChild variant="outline" size="sm"><Link to={`/${entity.name}/${row.id}/edit`}><Pencil />Edit</Link></Button>}
                {mayDelete && <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}><Trash2 />Delete</Button>}
              </div>
            )}
          </div>
        </div>
      </div>
      {cta && (
        <div className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-3 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur lg:hidden" role="region" aria-label="Buy">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{name}</p>{priceNode && <p className="font-semibold tabular-nums">{priceNode}</p>}</div>
          <div className="w-44 shrink-0 [&_a]:h-11 [&_button]:h-11">{cta}</div>
        </div>
      )}
      {related && <div className="mt-12 grid gap-6">{related}</div>}
    </>
  );
}
