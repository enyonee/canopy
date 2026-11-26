// A dashboard (`/dashboard/<id>`): stat cards, grouped tables and charts, all numbers the server aggregated for the
// viewer and the period. One view per card: a chart when there are three groups or more (area over time, bars for
// categories, the theme's chart colours, status groups in their status colours), else the table; the table of a chart
// is one click away ("Show table").
import { useId, useState } from 'react';
import { useQueries, useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, ArrowDownRight, ArrowUpRight, Inbox, Package, ShoppingBag, Target, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Sparkline } from '@/components/sparkline';
import { DateRange } from '@/components/date-range';
import { statusTone, toneVars } from '@/lib/visual';
import { app } from '@/gen/app';
import { endpoints } from '@/gen/endpoints';
import type { Dashboard as Spec, Group } from '@/lib/model';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { Guard } from '@/components/guard';
import { canSee } from '@/lib/perms';
import { enumLabel, formatDate, formatMoney, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type GroupRow = Record<string, unknown> & { grp?: unknown; _labels?: { grp?: string } };
type Point = { name: string; v: number; color?: string };

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

function ChartTip({ active, payload, label, money, metric }: { active?: boolean; payload?: { value: number; payload: Point }[]; label?: string; money: boolean; metric: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{label}</p>
      <p className="flex items-center justify-between gap-4 text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: payload[0].payload.color ?? 'var(--chart-1)' }} aria-hidden="true" />{metric}</span>
        <span className="font-medium text-foreground tabular-nums">{value(money, payload[0].value)}</span>
      </p>
    </div>
  );
}

// One series: an area over time (40 % → 0 gradient, 2 px line), bars for categories (4 px top radius, ≤ 48 px), slices.
function SeriesChart({ type, data, money, metric, title }: { type: string; data: Point[]; money: boolean; metric: string; title: string }) {
  const gid = `ch${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const axis = { stroke: 'var(--muted-foreground)', fontSize: 12, tickLine: false, axisLine: false } as const;
  const fmt = (v: number) => (money ? formatMoney(v) : formatNumber(v));
  const grid = <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />;
  const tip = <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.5 }} content={<ChartTip money={money} metric={metric} />} />;
  return (
    <div className="h-64 w-full" role="img" aria-label={`${title}: ${data.map((d) => `${d.name} ${fmt(d.v)}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        {type === 'pie' ? (
          <PieChart>
            {tip}
            <Pie data={data} dataKey="v" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
              {data.map((d, i) => <Cell key={d.name} fill={d.color ?? `var(--chart-${(i % 5) + 1})`} />)}
            </Pie>
          </PieChart>
        ) : type === 'line' || type === 'area' ? (
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--chart-1)" stopOpacity={0.4} />
                <stop offset="1" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {grid}
            <XAxis dataKey="name" {...axis} minTickGap={16} />
            <YAxis {...axis} width={56} tickFormatter={fmt} allowDecimals={money} />
            <Tooltip content={<ChartTip money={money} metric={metric} />} />
            <Area type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={2} fill={`url(#${gid}-a)`} dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} />
          </AreaChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={8}>
            {grid}
            <XAxis dataKey="name" {...axis} interval={0} />
            <YAxis {...axis} width={56} tickFormatter={fmt} allowDecimals={money} />
            {tip}
            <Bar dataKey="v" radius={[4, 4, 0, 0]} maxBarSize={48}>
              {data.map((d) => <Cell key={d.name} fill={d.color ?? 'var(--chart-1)'} />)}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function GroupTable({ title, groupTitle, metrics, rows, group }: { title: string; groupTitle: string; metrics: Spec['tables'][number]['metrics']; rows: GroupRow[]; group: Group | null }) {
  return (
    <Table>
      <caption className="sr-only">{title}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{groupTitle}</TableHead>
          {metrics.map((m) => <TableHead key={m.as} className="text-right">{m.title}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="font-medium">{groupText(group, r)}</TableCell>
            {metrics.map((m) => <TableCell key={m.as} className="text-right tabular-nums">{value(m.money, r[m.as])}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GroupedCard({ spec, rows }: { spec: Spec['tables'][number]; rows: GroupRow[] }) {
  const [showTable, setShowTable] = useState(false);
  const first = spec.metrics[0];
  const owner = app.entities[spec.entity];
  const byStatus = Boolean(spec.group && owner?.states?.field === spec.group.field);
  const series: Point[] = rows.map((r) => ({ name: groupText(spec.group, r), v: Number(r[first?.as] ?? 0),
    color: byStatus ? toneVars(statusTone(owner, String(r.grp ?? ''))).dot : undefined }));
  const overTime = spec.group?.kind === 'date' || spec.group?.kind === 'time';
  const chartable = Boolean(first) && rows.length >= 3;
  const subtitle = first ? `${first.title} by ${(spec.groupTitle ?? 'group').toLowerCase()}` : '';
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{spec.title}</CardTitle>
        {subtitle && subtitle.toLowerCase() !== spec.title.toLowerCase() && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {rows.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
          : chartable && !showTable ? <SeriesChart type={overTime ? 'area' : 'bar'} data={series} money={first.money} metric={first.title} title={spec.title} />
          : <GroupTable title={spec.title} groupTitle={spec.groupTitle ?? 'Group'} metrics={spec.metrics} rows={rows} group={spec.group} />}
      </CardContent>
      {chartable && (
        <div className="px-6">
          <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" aria-expanded={showTable} onClick={() => setShowTable(!showTable)}>
            {showTable ? 'Show chart' : 'Show table'}
          </Button>
        </div>
      )}
    </Card>
  );
}

const KPI_ICONS: [RegExp, LucideIcon][] = [[/revenue|sales|income|paid|amount|value|price|spent|balance/i, Wallet], [/order|purchase|cart/i, ShoppingBag],
  [/product|item|stock|inventory/i, Package], [/lead|deal|opportunit/i, Target], [/won|win|success|closed/i, Trophy],
  [/user|customer|client|patient|member|people/i, Users], [/open|pending|due|task/i, Inbox]];
const kpiIcon = (title: string) => KPI_ICONS.find(([re]) => re.test(title))?.[1] ?? Activity;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Monthly history of the cards whose entity the dashboard's period narrows: eight GETs of the same dashboard, one per
// calendar month, plus one for the same days of the previous month (the honest base of the delta: the current month
// is not over), run in parallel and cached (useQueries, staleTime 60 s). Not fetched while a period is chosen, when
// no card shows them.
const MONTHS = 8;
function useSeries(spec: Spec, on: boolean) {
  const now = new Date();
  const periods = Array.from({ length: MONTHS }, (_, k) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1) + k, 1));
    return { from: iso(start), to: iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))) };
  });
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, Math.min(now.getUTCDate(), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate())));
  const sameDays = { from: iso(prevStart), to: iso(prevEnd) };
  const wanted = on && spec.period && spec.cards.some((c) => spec.periodEntities.includes(c.entity));
  const qs = useQueries({ queries: wanted ? [...periods, sameDays].map((p) => ({ queryKey: ['dashboard', spec.id, p], queryFn: () => endpoints.dashboards[spec.id](p), staleTime: 60_000 })) : [] });
  if (!qs.length || qs.some((q) => !q.data)) return null;
  const months = qs.slice(0, MONTHS), base = qs[MONTHS];
  return spec.cards.map((c, i) => (spec.periodEntities.includes(c.entity)
    ? { line: months.map((q) => Number(q.data!.cards[i]?.value ?? 0)), sameDaysBefore: Number(base.data!.cards[i]?.value ?? 0) } : null));
}

// The history a card can draw: from its first non-zero month to now, at least 7 months, else none.
const history = (line: number[] | null) => {
  if (!line) return null;
  const start = line.findIndex((x) => x !== 0);
  return start >= 0 && line.length - start >= 7 ? line.slice(start) : null;
};

function Kpi({ card, value: v, pending, series, ranged }: { card: Spec['cards'][number]; value: number | undefined; pending: boolean; series: { line: number[]; sameDaysBefore: number } | null; ranged: boolean }) {
  const Icon = kpiIcon(`${card.title} ${card.entity}`);
  const line = series?.line ?? null;
  const shown = history(line);
  // This month so far against the same days of last month: both incomplete in the same way.
  const now = line ? line[line.length - 1] : 0, before = series?.sameDaysBefore ?? 0;
  const delta = series && before !== 0 ? ((now - before) / Math.abs(before)) * 100 : null;
  return (
    <Card className="gap-0 py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex items-end justify-between gap-3">
          {pending ? <Skeleton className="h-8 w-28" />
            : <p className="text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums" data-metric={card.title}>{value(card.money, v ?? 0)}</p>}
          {shown && <Sparkline values={shown} className="h-8 w-24" />}
        </div>
        <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
          {delta !== null && (
            <span className={cn('inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 font-medium tabular-nums', delta >= 0 ? 'text-success' : 'text-danger')}>
              {delta >= 0 ? <ArrowUpRight className="size-3.5" aria-hidden="true" /> : <ArrowDownRight className="size-3.5" aria-hidden="true" />}
              {`${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`}
            </span>
          )}
          <span>{delta !== null ? 'month to date vs same days last month' : ranged ? 'In the selected period' : card.fn === 'count' ? 'All records' : 'All time'}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardBody({ spec }: { spec: Spec }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { from?: string; to?: string };
  const from = search.from ?? '', to = search.to ?? '';
  const series = useSeries(spec, !from && !to);
  const query = { from: from || undefined, to: to || undefined };
  const data = useQuery({ queryKey: ['dashboard', spec.id, query], queryFn: () => endpoints.dashboards[spec.id](query), placeholderData: keepPreviousData,
    refetchInterval: spec.refresh ? spec.refresh * 1000 : false });
  const setPeriod = (f: string, t: string) => void navigate({ to: '.', search: { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) }, replace: true });
  const blocks = spec.tables.length + spec.charts.length;
  return (
    <>
      <PageHeader title={spec.title} description={spec.intro ?? undefined} actions={spec.period ? <DateRange from={from} to={to} onChange={setPeriod} /> : undefined} />
      <div className="space-y-6" aria-busy={data.isFetching || undefined}>
        {data.isError ? <ErrorState error={data.error} retry={() => void data.refetch()} /> : (
          <>
            {spec.cards.length > 0 && (
              <section aria-label="Key figures" className={cn('grid gap-4 sm:grid-cols-2', spec.cards.length === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4')}>
                {spec.cards.map((c, i) => <Kpi key={c.title} card={c} value={data.data?.cards[i]?.value} pending={data.isPending}
                  series={series?.[i] ?? null} ranged={Boolean(from || to) && spec.periodEntities.includes(c.entity)} />)}
              </section>
            )}
            <div className="grid gap-6 xl:grid-cols-2">
              {spec.tables.map((t, i) => (
                <div key={t.title} className={cn(blocks % 2 === 1 && i === blocks - 1 && 'xl:col-span-2')}>
                  {data.isPending ? <Skeleton className="h-80 rounded-xl" /> : <GroupedCard spec={t} rows={(data.data.tables[i]?.rows ?? []) as GroupRow[]} />}
                </div>
              ))}
              {spec.charts.map((c, i) => (
                <div key={c.title} className={cn(blocks % 2 === 1 && spec.tables.length + i === blocks - 1 && 'xl:col-span-2')}>
                  {data.isPending ? <Skeleton className="h-80 rounded-xl" /> : (
                    <Card className="gap-4">
                      <CardHeader><CardTitle>{c.title}</CardTitle></CardHeader>
                      <CardContent className="px-3 sm:px-6">
                        {(data.data.charts[i]?.rows ?? []).length < 3
                          ? <p className="py-10 text-center text-3xl font-semibold tabular-nums">{value(c.money, (data.data.charts[i]?.rows ?? []).reduce((s, r) => s + Number(r.v ?? 0), 0))}</p>
                          : <SeriesChart type={c.type} money={c.money} metric={c.title} title={c.title}
                              data={(data.data.charts[i]?.rows ?? []).map((r) => ({ name: groupText(c.group, r as GroupRow), v: Number(r.v ?? 0) }))} />}
                      </CardContent>
                    </Card>
                  )}
                </div>
              ))}
            </div>
            {spec.cards.length + blocks === 0 && <EmptyState title="This dashboard is empty" />}
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
