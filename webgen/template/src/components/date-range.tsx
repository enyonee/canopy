// The period of a dashboard: one button showing the range, opening presets (7 days, 30 days, this year, all time) and a
// month calendar where two clicks pick a range. Keyboard: the days are buttons with full-date names; Escape closes.
import { useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const dayName = new Intl.DateTimeFormat('en-US', { dateStyle: 'full' });

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date((from ? new Date(`${from}T00:00:00`) : today).getFullYear(), (from ? new Date(`${from}T00:00:00`) : today).getMonth(), 1));
  const [pick, setPick] = useState<string | null>(null);
  const ago = (days: number) => iso(new Date(today.getTime() - days * 86_400_000));
  const presets = [
    { label: 'Last 7 days', from: ago(6), to: iso(today) },
    { label: 'Last 30 days', from: ago(29), to: iso(today) },
    { label: 'This year', from: `${today.getFullYear()}-01-01`, to: iso(today) },
    { label: 'All time', from: '', to: '' },
  ];
  const current = presets.find((p) => p.from === from && p.to === to);
  const label = current?.label ?? `${formatDate(from, 'date') || '…'} – ${formatDate(to, 'date') || '…'}`;
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const choose = (d: string) => {
    if (!pick) { setPick(d); return; }
    const [a, b] = [pick, d].sort();
    setPick(null); onChange(a, b); setOpen(false);
  };
  const lo = pick ?? from, hi = pick ? pick : to;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setPick(null); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="min-w-52 justify-start gap-2 font-normal" aria-label={`Period: ${label}`}>
          <CalendarRange className="text-muted-foreground" />{label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-auto flex-col gap-4 sm:flex-row">
        <div className="flex flex-col gap-1 sm:w-36" role="group" aria-label="Quick periods">
          {presets.map((p) => (
            <Button key={p.label} size="sm" variant={p === current ? 'secondary' : 'ghost'} className="justify-start" aria-pressed={p === current}
              onClick={() => { onChange(p.from, p.to); setOpen(false); }}>{p.label}</Button>
          ))}
        </div>
        <div className="w-64">
          <div className="mb-2 flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></Button>
            <p className="text-sm font-medium" aria-live="polite">{monthName.format(month)}</p>
            <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></Button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => <span key={d} className="py-1 text-muted-foreground" aria-hidden="true">{d}</span>)}
            {cells.map((d, i) => {
              if (!d) return <span key={`e${i}`} />;
              const s = iso(d);
              const edge = s === lo || s === hi;
              const inside = lo && hi && s > lo && s < hi;
              return (
                <button key={s} type="button" aria-label={dayName.format(d)} aria-pressed={edge || undefined} onClick={() => choose(s)}
                  className={cn('h-8 rounded-md text-sm tabular-nums hover:bg-accent', inside && 'rounded-none bg-accent', edge && 'bg-primary text-primary-foreground hover:bg-primary',
                    s === iso(today) && !edge && 'font-semibold text-accent-text')}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{pick ? 'Pick the last day.' : 'Pick the first day.'}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
