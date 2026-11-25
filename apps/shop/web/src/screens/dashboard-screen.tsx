// A dashboard (`/dashboard/<id>`): stat cards, grouped tables and charts, all numbers the server aggregated for the
// viewer and the period. A grouped table also reads as a chart of its first metric (Chart / Table tabs: the same rows).
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, CalendarRange, Table2 } from 'lucide-react';
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
function SeriesChart({ type, data, money, metric, title }: { type: string; data: { name: string; v: number }[]; money: boolean; metric: string; title: string }) {
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
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={56} tickFormatter={fmt} />
            <Tooltip content={<ChartTip money={money} metric={metric} />} />
            <Line type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 4, fill: 'var(--chart-1)', stroke: 'var(--card)', strokeWidth: 2 }} activeDot={{ r: 6 }} />
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="name" {...axis} interval={0} />
            <YAxis {...axis} width={56} tickFormatter={fmt} allowDecimals={money} />
            {tip}
            <Bar dataKey="v" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function GroupedTable({ spec, rows }: { spec: Spec['tables'][number]; rows: GroupRow[] }) {
  const first = spec.metrics[0];
  const series = rows.map((r) => ({ name: groupText(spec.group, r), v: Number(r[first?.as] ?? 0) }));
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

function DashboardBody({ spec }: { spec: Spec }) {
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
                {spec.cards.map((c, i) => (
                  <Card key={c.title} className="gap-2 py-5">
                    <CardContent className="space-y-2 px-5">
                      <p className="text-sm font-medium text-muted-foreground">{c.title}</p>
                      {data.isPending ? <Skeleton className="h-8 w-24" />
                        : <p className="text-3xl font-semibold tracking-tight tabular-nums" data-metric={c.title}>{value(c.money, data.data.cards[i]?.value ?? 0)}</p>}
                    </CardContent>
                  </Card>
                ))}
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
