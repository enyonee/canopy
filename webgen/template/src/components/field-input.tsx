// The form control of one field, by kind: text, multiline, number and money, a yes/no, a choice of an enum or of
// referenced rows, a date, a secret. Validation comes from the graph: `!` is required, simple `rules` checks
// (`price >= 0`) are bounds, a percent is 0–100; the server judges everything else and its 400 is shown.
import { Controller, type Control, type RegisterOptions } from 'react-hook-form';
import type { Field } from '@/lib/model';
import type { Body } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { enumLabel } from '@/lib/format';
import { useOptions } from '@/lib/refs';
import type { Viewer } from '@/lib/perms';

export type FormValues = Record<string, string | boolean>;

const numeric = (f: Field) => f.kind === 'money' || f.type === 'integer' || f.type === 'number';
const EMPTY = '__empty__';

/** The rules react-hook-form checks before anything is posted. */
export function rulesFor(f: Field, required: boolean): RegisterOptions<FormValues> {
  return {
    validate: (raw) => {
      const v = typeof raw === 'string' ? raw.trim() : raw;
      if (f.kind === 'bool') return true;
      if (v === '' || v === undefined) return required ? `${f.label} is required` : true;
      if (numeric(f)) {
        const n = Number(v);
        if (Number.isNaN(n)) return `${f.label} must be a number`;
        if (f.type === 'integer' && !Number.isInteger(n)) return `${f.label} must be a whole number`;
        if (f.kind === 'money' && !/^-?\d+(\.\d{1,2})?$/.test(String(v))) return `${f.label} has at most two decimals`;
        for (const b of f.bounds) {
          const ok = b.op === '>=' ? n >= b.value : b.op === '>' ? n > b.value : b.op === '<=' ? n <= b.value : n < b.value;
          if (!ok) return b.message;
        }
      }
      if (/email/i.test(f.name) && f.kind === 'text' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) return 'Enter a valid email address';
      return true;
    },
  };
}

/** A row's value as the form holds it (text, or a boolean for a checkbox). */
export function toFormValue(f: Field, v: unknown): string | boolean {
  if (f.kind === 'bool') return v === null || v === undefined ? f.default === 'true' : Boolean(v);
  if (f.secret) return '';
  if (v === null || v === undefined) return f.default !== null && !['today', 'now'].includes(f.default) ? f.default : '';
  return String(v);
}

/** The form's value as the JSON body sends it: numbers as numbers, an empty value as null. */
export function toBody(fields: readonly Field[], values: FormValues, names: readonly string[]): Body {
  const out: Body = {};
  for (const name of names) {
    const f = fields.find((x) => x.name === name);
    const v = values[name];
    if (!f) continue;
    if (f.kind === 'bool') { out[name] = Boolean(v); continue; }
    const s = typeof v === 'string' ? v.trim() : '';
    if (f.secret && s === '') continue; // a blank password keeps the old one
    if (s === '') out[name] = null;
    else if (numeric(f) || f.kind === 'ref') out[name] = Number(s);
    else out[name] = s;
  }
  return out;
}

function RefSelect({ f, value, onChange, invalid, viewer, id, required }: { f: Field; value: string; onChange: (v: string) => void; invalid: boolean; viewer: Viewer; id: string; required: boolean }) {
  const options = useOptions(f.target, viewer);
  return (
    <Select value={value || (required ? undefined : EMPTY)} onValueChange={(v) => onChange(v === EMPTY ? '' : v)}>
      <SelectTrigger id={id} aria-invalid={invalid || undefined} aria-busy={options.isPending || undefined}>
        <SelectValue placeholder={options.isPending ? 'Loading…' : `Choose ${f.label.toLowerCase()}`} />
      </SelectTrigger>
      <SelectContent>
        {!required && <SelectItem value={EMPTY}>None</SelectItem>}
        {(options.data ?? []).map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function FieldInput({ f, control, viewer, required, error, autoFocus }: { f: Field; control: Control<FormValues>; viewer: Viewer; required: boolean; error?: string; autoFocus?: boolean }) {
  const id = `f_${f.name}`;
  const describedBy = error ? `${id}_error` : undefined;
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, 'aria-required': required || undefined, autoFocus };
  return (
    <div className="grid gap-2">
      {f.kind !== 'bool' && (
        <Label htmlFor={id}>
          {f.label}
          {required ? <span className="text-destructive" aria-hidden="true">*</span> : <span className="text-xs font-normal text-muted-foreground">optional</span>}
        </Label>
      )}
      <Controller
        name={f.name}
        control={control}
        rules={rulesFor(f, required)}
        render={({ field }) => {
          const value = field.value;
          if (f.kind === 'bool') {
            return (
              <div className="flex items-center gap-2.5">
                <Checkbox {...common} checked={Boolean(value)} onCheckedChange={(c) => field.onChange(c === true)} onBlur={field.onBlur} ref={field.ref} />
                <Label htmlFor={id} className="font-normal">{f.label}</Label>
              </div>
            );
          }
          const s = typeof value === 'string' ? value : '';
          if (f.kind === 'ref') return <RefSelect f={f} value={s} onChange={field.onChange} invalid={Boolean(error)} viewer={viewer} id={id} required={required} />;
          if (f.kind === 'enum' && f.options) {
            return (
              <Select value={s || undefined} onValueChange={field.onChange}>
                <SelectTrigger {...common} ref={field.ref}><SelectValue placeholder={`Choose ${f.label.toLowerCase()}`} /></SelectTrigger>
                <SelectContent>{f.options.map((o) => <SelectItem key={o} value={o}>{enumLabel(o)}</SelectItem>)}</SelectContent>
              </Select>
            );
          }
          if (f.kind === 'longtext') return <Textarea {...common} {...field} value={s} rows={4} />;
          if (numeric(f)) {
            const suffix = f.kind === 'percent' ? '%' : null;
            return (
              <div className="relative">
                <Input {...common} {...field} value={s} type="text" inputMode={f.type === 'integer' ? 'numeric' : 'decimal'} className={suffix ? 'pr-8' : undefined} />
                {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{suffix}</span>}
              </div>
            );
          }
          const type = f.secret ? 'password' : f.kind === 'date' ? 'date' : /email/i.test(f.name) ? 'email' : 'text';
          const auto = f.secret ? 'current-password' : /email/i.test(f.name) ? 'email' : /^name$/i.test(f.name) ? 'name' : /address/i.test(f.name) ? 'street-address' : undefined;
          return <Input {...common} {...field} value={s} type={type} autoComplete={auto} />;
        }}
      />
      {error && <p id={`${id}_error`} className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}
