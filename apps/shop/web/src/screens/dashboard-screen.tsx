// A dashboard (`/dashboard/<id>`): stat cards, grouped tables and charts, all numbers the server aggregated for the
// viewer and the period. A grouped table also reads as a chart of its first metric (Chart / Table tabs: the same rows).
import { useId } from 'react';
import { useQueries, useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, BarChart3, CalendarRange, Inbox, Package, ShoppingBag, Table2, Target, TrendingDown, TrendingUp, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Sparkline } from '@/components/sparkline';
import { statusTone, toneVars } from '@/lib/visual';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Dashboard as Spec, Group } from '@/lib/model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Guard } from '@/components/guard';
import { canSee } from '@/lib/perms';
import { enumLabel, formatDate, formatMoney, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type GroupRow = Record<string, unknown> & { grp?: unknown; _labels?: { grp?: string } };

const groupText = (g: Group | null, r: GroupRow) => {
  if (!g) return 'All';
  if (r._labels?.grp) return r._labels.grp;
  const v = r.grp;
  if (v === null || v === undefined || v === '') return '—';
  if (g.kind === 'enum') return enumLabel(v);
  if (g.kind === 'ref') return `#${String(v)}`;
  if (g.kind === 'bool') return v ? 'Yes' : 'No';
  if (g.kind === 'date' || g.kind === 'time') return formatDate(v, g.unit ? 'date' : g.kind);
  return String(v);
};
const value = (money: boolean, v: unknown) => (v === null || v === undefined ? '—' : money ? formatMoney(v) : formatNumber(v));
const iso = (d: Date) => d.toISOString().slice(0, 10);

function Period({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const today = new Date();
  const ago = (days: number) => iso(new Date(today.getTime() - days * 86_400_000));
  const presets = [
    { label: '7 days', from: ago(6), to: iso(today) },
    { label: '30 days', from: ago(29), to: iso(today) },
    { label: 'This year', from: `${today.getFullYear()}-01-01`, to: iso(today) },
    { label: 'All time', from: '', to: '' },
  ];
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-end">
      <legend className="sr-only">Period</legend>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground sm:pb-2"><CalendarRange className="size-4" aria-hidden="true" />Period</div>
      <div className="grid gap-1.5"><Label htmlFor="period-from" className="text-xs text-muted-foreground">From</Label><Input id="period-from" type="date" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} className="sm:w-40" /></div>
      <div className="grid gap-1.5"><Label htmlFor="period-to" className="text-xs text-muted-foreground">To</Label><Input id="period-to" type="date" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} className="sm:w-40" /></div>
      <div className="flex flex-wrap gap-1 sm:ml-auto" role="group" aria-label="Quick periods">
        {presets.map((p) => (
          <Button key={p.label} type="button" size="sm" variant={p.from === from && p.to === to ? 'secondary' : 'ghost'} aria-pressed={p.from === from && p.to === to} onClick={() => onChange(p.from, p.to)}>{p.label}</Button>
        ))}
      </div>
    </fieldset>
  );
}

function ChartTip({ active, payload, label, money, metric }: { active?: boolean; payload?: { value: number }[]; label?: string; money: boolean; metric: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{label}</p>
      <p className="text-muted-foreground">{metric}: <span className="font-medium text-foreground tabular-nums">{value(money, payload[0].value)}</span></p>
    </div>
  );
}

// One series in the theme's accent: bars for categories, a line over time, slices for a share.
function SeriesChart({ type, data, money, metric, title }: { type: string; data: { name: string; v: number; color?: string }[]; money: boolean; metric: string; title: string }) {
  const gid = `ch${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const axis = { stroke: 'var(--muted-foreground)', fontSize: 12, tickLine: false, axisLine: false } as const;
  const tip = <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.6 }} content={<ChartTip money={money} metric={metric} />} />;
  const fmt = (v: number) => (money ? formatMoney(v) : formatNumber(v));
  return (
    <div className="h-64 w-full" role="img" aria-label={`${title}: ${data.map((d) => `${d.name} ${fmt(d.v)}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        {type === 'pie' ? (
          <PieChart>
            {tip}
            <Pie data={data} dataKey="v" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
              {data.map((d, i) => <Cell key={d.name} fill={`var(--chart-${(i % 5) + 1})`} />)}
            </Pie>
          </PieChart>
        ) : type === 'line' ? (
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${gid}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--chart-1)" stopOpacity={0.35} />
                <stop offset="1" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={56} tickFormatter={fmt} />
            <Tooltip content={<ChartTip money={money} metric={metric} />} />
            <Area type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={2} fill={`url(#${gid}-area)`} dot={{ r: 4, fill: 'var(--chart-1)', stroke: 'var(--card)', strokeWidth: 2 }} activeDot={{ r: 6 }} />
          </AreaChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="30%">
            <defs>
              <linearGradient id={`${gid}-bar`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--chart-1)" stopOpacity={1} />
                <stop offset="1" stopColor="var(--chart-1)" stopOpacity={0.55} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="name" {...axis} interval={0} />
            <YAxis {...axis} width={56} tickFormatter={fmt} allowDecimals={money} />
            {tip}
            <Bar dataKey="v" fill={`url(#${gid}-bar)`} radius={[6, 6, 0, 0]} maxBarSize={48}>
              {data.map((d) => <Cell key={d.name} fill={d.color ?? `url(#${gid}-bar)`} />)}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function GroupedTable({ spec, rows }: { spec: Spec['tables'][number]; rows: GroupRow[] }) {
  const first = spec.metrics[0];
  // Groups by an entity's status take the status colours of its badges.
  const owner = app.entities[spec.entity];
  const byStatus = Boolean(spec.group && owner?.states?.field === spec.group.field);
  const series = rows.map((r) => ({ name: groupText(spec.group, r), v: Number(r[first?.as] ?? 0),
    color: byStatus ? toneVars(statusTone(owner, String(r.grp ?? ''))).dot : undefined }));
  const overTime = spec.group?.kind === 'date' || spec.group?.kind === 'time';
  const subtitle = first ? `${first.title} by ${(spec.groupTitle ?? 'group').toLowerCase()}` : '';
  const table = (
    <Table>
      <caption className="sr-only">{spec.title}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{spec.groupTitle ?? 'Group'}</TableHead>
          {spec.metrics.map((m) => <TableHead key={m.as} className="text-right">{m.title}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="font-medium">{groupText(spec.group, r)}</TableCell>
            {spec.metrics.map((m) => <TableCell key={m.as} className="text-right tabular-nums">{value(m.money, r[m.as])}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  return (
    <Card className="gap-4">
      <Tabs defaultValue={first && rows.length > 1 ? 'chart' : 'table'}>
        <CardHeader className="grid-cols-[1fr_auto]">
          <div className="space-y-1.5"><CardTitle>{spec.title}</CardTitle>{first && subtitle.toLowerCase() !== spec.title.toLowerCase() && <CardDescription>{subtitle}</CardDescription>}</div>
          {first && rows.length > 0 && (
            <TabsList aria-label={`${spec.title} view`}>
              <TabsTrigger value="chart"><BarChart3 />Chart</TabsTrigger>
              <TabsTrigger value="table"><Table2 />Table</TabsTrigger>
            </TabsList>
          )}
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {rows.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No data for this period.</p> : (
            <>
              {first && <TabsContent value="chart"><SeriesChart type={overTime ? 'line' : 'bar'} data={series} money={first.money} metric={first.title} title={spec.title} /></TabsContent>}
              <TabsContent value="table">{table}</TabsContent>
            </>
          )}
        </CardContent>
      </Tabs>
    </Card>
  );
}

const KPI_ICONS: [RegExp, LucideIcon][] = [[/revenue|sales|income|paid|amount|value|price|spent|balance/i, Wallet], [/order|purchase|cart/i, ShoppingBag],
  [/product|item|stock|inventory/i, Package], [/lead|deal|opportunit/i, Target], [/won|win|success|closed/i, Trophy],
  [/user|customer|client|patient|member|people/i, Users], [/open|pending|due|task/i, Inbox]];
const kpiIcon = (title: string) => KPI_ICONS.find(([re]) => re.test(title))?.[1] ?? Activity;

// The last six calendar months, oldest first, as the period each card is computed over: the sparkline of a card
// whose entity the dashboard's `period` narrows. Six more GETs of the same dashboard, computed by the server.
function months() {
  const now = new Date();
  return Array.from({ length: 6 }, (_, k) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + k, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return { from: iso(start), to: iso(end) };
  });
}

function useSeries(spec: Spec) {
  const periods = months();
  const qs = useQueries({ queries: spec.period && spec.cards.some((c) => spec.periodEntities.includes(c.entity))
    ? periods.map((p) => ({ queryKey: ['dashboard', spec.id, p], queryFn: () => endpoints.dashboards[spec.id](p), staleTime: 60_000 })) : [] });
  if (!qs.length || qs.some((q) => !q.data)) return null;
  return spec.cards.map((c, i) => (spec.periodEntities.includes(c.entity) ? qs.map((q) => Number(q.data!.cards[i]?.value ?? 0)) : null));
}

function Kpi({ spec, card, index, value: v, pending, series }: { spec: Spec; card: Spec['cards'][number]; index: number; value: number | undefined; pending: boolean; series: (number[] | null)[] | null }) {
  const Icon = kpiIcon(`${card.title} ${card.entity}`);
  const line = series?.[index] ?? null;
  const [prev, last] = line ? line.slice(-2) : [0, 0];
  const delta = line && prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null;
  void spec;
  return (
    <Card className="relative gap-3 overflow-hidden py-5 shadow-sm">
      <CardContent className="space-y-3 px-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true"><Icon className="size-[18px]" /></span>
        </div>
        {pending ? <Skeleton className="h-9 w-28" />
          : <p className="text-3xl font-semibold tracking-tight tabular-nums" data-metric={card.title}>{value(card.money, v ?? 0)}</p>}
        <div className="flex h-8 items-end justify-between gap-3">
          {delta !== null ? (
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', delta >= 0 ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/12 text-rose-700 dark:text-rose-300')}>
              {delta >= 0 ? <TrendingUp className="size-3.5" aria-hidden="true" /> : <TrendingDown className="size-3.5" aria-hidden="true" />}
              {`${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`}<span className="sr-only"> compared with the month before</span>
            </span>
          ) : line ? <span className="text-xs text-muted-foreground">Last 6 months</span> : <span />}
          {line && line.filter((x) => x !== 0).length >= 3 && <Sparkline values={line} className="h-8 w-28" />}
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardBody({ spec }: { spec: Spec }) {
  const series = useSeries(spec);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { from?: string; to?: string };
  const from = search.from ?? '', to = search.to ?? '';
  const query = { from: from || undefined, to: to || undefined };
  const data = useQuery({ queryKey: ['dashboard', spec.id, query], queryFn: () => endpoints.dashboards[spec.id](query), placeholderData: keepPreviousData,
    refetchInterval: spec.refresh ? spec.refresh * 1000 : false });
  const setPeriod = (f: string, t: string) => void navigate({ to: '.', search: { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) }, replace: true });
  return (
    <>
      <PageHeader title={spec.title} description={spec.intro ?? undefined} />
      <div className="space-y-6" aria-busy={data.isFetching || undefined}>
        {spec.period && <Period from={from} to={to} onChange={setPeriod} />}
        {data.isError ? <ErrorState error={data.error} retry={() => void data.refetch()} /> : (
          <>
            {spec.cards.length > 0 && (
              <section aria-label="Key figures" className={cn('grid gap-4 sm:grid-cols-2', spec.cards.length === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4')}>
                {spec.cards.map((c, i) => <Kpi key={c.title} spec={spec} card={c} index={i} value={data.data?.cards[i]?.value} pending={data.isPending} series={series} />)}
              </section>
            )}
            <div className="grid gap-6 xl:grid-cols-2">
              {spec.tables.map((t, i) => data.isPending ? <Skeleton key={t.title} className="h-80 rounded-xl" /> : <GroupedTable key={t.title} spec={t} rows={(data.data.tables[i]?.rows ?? []) as GroupRow[]} />)}
              {spec.charts.map((c, i) => data.isPending ? <Skeleton key={c.title} className="h-80 rounded-xl" /> : (
                <Card key={c.title} className="gap-4">
                  <CardHeader><CardTitle>{c.title}</CardTitle></CardHeader>
                  <CardContent className="px-3 sm:px-6">
                    <SeriesChart type={c.type} money={c.money} metric={c.title} title={c.title}
                      data={(data.data.charts[i]?.rows ?? []).map((r) => ({ name: groupText(c.group, r as GroupRow), v: Number(r.v ?? 0) }))} />
                  </CardContent>
                </Card>
              ))}
            </div>
            {spec.cards.length + spec.tables.length + spec.charts.length === 0 && <EmptyState title="This dashboard is empty" />}
          </>
        )}
      </div>
    </>
  );
}

export function DashboardScreen({ id }: { id: string }) {
  const spec = app.dashboards.find((d) => d.id === id)!;
  return <Guard allow={(v) => canSee(v, spec.roles)}><DashboardBody spec={spec} /></Guard>;
}
