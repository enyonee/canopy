// How a value of each field kind reads on screen. Money is a major-unit number in every JSON answer and reads
// with two decimals, like the runtime's own screens; the graph names no currency, so none is invented.
import type { Field } from '@/lib/model';

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('en-US');
const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const monthFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short' });

export const formatMoney = (v: unknown) => (v === null || v === undefined || v === '' ? '' : money.format(Number(v)));
export const formatNumber = (v: unknown) => (v === null || v === undefined || v === '' ? '' : number.format(Number(v)));

/** "paypal" → "Paypal", "in_progress" → "In progress": an enum value's caption. */
export const enumLabel = (v: unknown) => {
  const s = String(v ?? '').replace(/[_-]+/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

export function formatDate(v: unknown, kind: string) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}$/.test(s)) return monthFmt.format(new Date(`${s}-01T00:00:00`));
  if (/^\d{4}$/.test(s)) return s;
  const d = new Date(kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return s;
  return kind === 'date' ? dateFmt.format(d) : timeFmt.format(d);
}

/** The text of a value (no markup): what a cell, a card or a screen reader reads. */
export function plainValue(f: Field | undefined, v: unknown, labels?: readonly string[]): string {
  if (v === null || v === undefined || v === '') return '';
  if (!f) return String(v);
  if (f.kind === 'money') return formatMoney(v);
  if (f.kind === 'bool') return (labels ?? ['No', 'Yes'])[v ? 1 : 0];
  if (f.kind === 'enum') return enumLabel(v);
  if (f.kind === 'percent') return `${formatNumber(v)} %`;
  if (f.kind === 'date' || f.kind === 'time') return formatDate(v, f.kind);
  if (f.type === 'integer' || f.type === 'number') return formatNumber(v);
  return String(v);
}

/** Initials for an avatar: "Ann Lee" → "AL", "ann@shop.test" → "AN". */
export function initials(s: string) {
  const parts = s.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '?';
}
