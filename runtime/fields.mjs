// Field kinds. One entry is the whole life of a kind: how it is stored, coerced,
// validated, read by expressions, rendered and edited. A plugin adds a kind by
// adding an entry with the same shape; the kernel never names a kind it can avoid.
//
//   sql         column type
//   exprKind    what an expression sees: number | money | text | bool | date | time | ref
//   numeric     may be adjusted, summed, range-filtered
//   temporal    may be a dashboard period, a month bucket, a range filter
//   secret      never rendered, never a column
//   derivable   may be the kind of a ":=" field
//   def(f)      stored default from the declared "=…" (f.def is the raw string)
//   coerce(raw) stored value from a form / seed / step value
//   validate(v, f) a message when the submitted value is unacceptable, else null; pure: it gets no
//               store (a reference's existence is the kernel's check, Store#checkValue)
//   toExpr(v)   stored → expression value (money → major units, bool → boolean)
//   fromExpr(v) expression value → stored (derived fields)
//   format(v, f, ctx) safe HTML for a cell; pure over data loaded before the page renders. ctx: { esc,
//               title(name) "createdAt" -> "Created At", label(target, id) the label of a row a
//               reference points at (prefetched, '' for none), entity, row, labels (the declared
//               boolean captions), statusField (the entity's state field, or null) }
//   input(f, v, ctx)  the form control, or null when the kind never appears on forms; ctx: { esc,
//               options(target) every row of a target as [{ id, label }] (prefetched), entity, row }
const today = () => new Date().toISOString().slice(0, 10);
// "2026-02-31" has the shape of a date and is not one: the calendar must agree.
const isCalendarDate = (v) => {
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const numberOrNull = (raw) => (raw === '' || raw === undefined || raw === null ? null : Number(raw));

// Half a cent rounds away from zero, so a refund mirrors the charge it reverses;
// the toFixed hop keeps 1.005 from landing a cent low through binary double dust.
export const toMinor = (v) => {
  if (v === '' || v === undefined || v === null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  return Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toFixed(6)));
};
export const toMajor = (v) => (v === null || v === undefined ? null : v / 100);
export const formatMoney = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2));

const textInput = (type, extra = '') => (f, v, { esc }) =>
  `<input type="${type}" id="f_${f.name}" name="${f.name}" value="${esc(v)}"${extra}${f.required ? ' required' : ''}>`;

const plain = { sql: 'TEXT', exprKind: 'text', derivable: true,
  def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)), validate: () => null,
  format: (v, f, { esc }) => esc(v), input: textInput('text') };

/** @type {Record<string, import('./types.d.ts').FieldType>} */
export const FIELDS = {
  text: { ...plain },
  longtext: { ...plain, input: (f, v, { esc }) => `<textarea id="f_${f.name}" name="${f.name}" rows="4"${f.required ? ' required' : ''}>${esc(v)}</textarea>` },
  bool: { sql: 'INTEGER', exprKind: 'bool', derivable: true,
    def: (f) => (f.def === 'true' ? 1 : 0),
    coerce: (raw) => (raw === true || raw === 1 || raw === 'true' || raw === 'on' || raw === '1' ? 1 : 0),
    validate: () => null, toExpr: (v) => Boolean(v), fromExpr: (v) => (v ? 1 : 0),
    format: (v, f, { esc, labels }) => { const pair = labels?.[f.name] || ['No', 'Yes']; return esc(v ? pair[1] : pair[0]); },
    input: (f, v) => `<input type="checkbox" id="f_${f.name}" name="${f.name}"${v ? ' checked' : ''}>` },
  int: { sql: 'INTEGER', exprKind: 'number', numeric: true, derivable: true,
    def: (f) => Number(f.def), coerce: (raw) => { const n = numberOrNull(raw); return n === null ? null : Math.round(n); },
    validate: (v, f) => {
      if (v === undefined || v === '' || v === null) return null;
      if (Number.isNaN(Number(v))) return `${f.name} must be a number`;
      return Number.isInteger(Number(v)) ? null : `${f.name} must be a whole number`;
    },
    fromExpr: (v) => (v === null || v === undefined ? null : Math.round(v)),
    format: (v, f, { esc }) => esc(v), input: textInput('number') },
  money: { sql: 'INTEGER', exprKind: 'money', numeric: true, derivable: true,
    def: (f) => toMinor(f.def), coerce: toMinor,
    validate: (v, f) => (v !== undefined && v !== '' && Number.isNaN(Number(v)) ? `${f.name} must be a number` : null),
    toExpr: toMajor, fromExpr: (v) => (v === null || v === undefined ? null : toMinor(v)),
    format: (v, f, { esc }) => esc(formatMoney(v)),
    input: (f, v, { esc }) => `<input type="number" step="0.01" id="f_${f.name}" name="${f.name}" value="${esc(v === null || v === undefined || v === '' ? '' : typeof v === 'number' ? formatMoney(v) : v)}"${f.required ? ' required' : ''}>` },
  date: { sql: 'TEXT', exprKind: 'date', temporal: true, derivable: true,
    def: (f) => (f.def === 'today' ? today() : f.def), coerce: (raw) => (raw === undefined ? null : String(raw)),
    validate: (v, f) => (v && !isCalendarDate(v) ? `${f.name} must be a real date (YYYY-MM-DD)` : null),
    format: (v, f, { esc }) => esc(v), input: textInput('date') },
  time: { sql: 'TEXT', exprKind: 'time', temporal: true, derivable: true,
    def: (f) => (f.def === 'now' ? new Date().toISOString() : f.def), coerce: (raw) => (raw === undefined ? null : String(raw)),
    validate: (v, f) => (v && Number.isNaN(new Date(String(v)).getTime()) ? `${f.name} must be a timestamp` : null),
    format: (v, f, { esc }) => esc(v), input: null },
  enum: { sql: 'TEXT', exprKind: 'text', derivable: false, structural: true,
    def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)),
    validate: (v, f) => (v && !f.options.includes(String(v)) ? `${f.name} must be one of: ${f.options.join(', ')}` : null),
    format: (v, f, { esc, title, statusField }) => (f.name === statusField
      ? `<span class="status">${esc(title(v ?? ''))}</span>` : esc(v)),
    input: (f, v, { esc }) => `<select id="f_${f.name}" name="${f.name}">` + f.options.map((o) => `<option${String(v) === o ? ' selected' : ''}>${esc(o)}</option>`).join('') + '</select>' },
  ref: { sql: 'TEXT', exprKind: 'ref', derivable: false, structural: true,
    def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)),
    validate: () => null,
    format: (v, f, { esc, label }) => { const lbl = label(f.target, v); return lbl ? `<a href="/${f.target}/${v}">${esc(lbl)}</a>` : '—'; },
    input: (f, v, { esc, options }) => `<select id="f_${f.name}" name="${f.name}"><option value="">—</option>` + options(f.target).map((o) =>
      `<option value="${o.id}"${String(v) === String(o.id) ? ' selected' : ''}>${esc(o.label)}</option>`).join('') + '</select>' },
  file: { sql: 'TEXT', exprKind: 'text', derivable: false, upload: true,
    def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)), validate: () => null,
    format: (v, f, { esc, entity, row }) => (v ? `<a href="/file/${entity}/${row.id}/${f.name}">${esc(String(v).replace(/^\d+-/, ''))}</a>` : '—'),
    input: (f, v, { esc }) => `<input type="file" id="f_${f.name}" name="${f.name}">${v ? `<span class="muted"> current: ${esc(String(v).replace(/^\d+-/, ''))}</span>` : ''}` },
  image: { sql: 'TEXT', exprKind: 'text', derivable: false, upload: true,
    def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)), validate: () => null,
    format: (v, f, { esc, entity, row }) => (v ? `<a href="/file/${entity}/${row.id}/${f.name}"><img class="thumb" src="/file/${entity}/${row.id}/${f.name}?inline=1" alt="${esc(String(v).replace(/^\d+-/, ''))}"></a>` : '—'),
    input: (f, v, { esc }) => `<input type="file" accept="image/*" id="f_${f.name}" name="${f.name}">${v ? `<span class="muted"> current: ${esc(String(v).replace(/^\d+-/, ''))}</span>` : ''}` },
  password: { sql: 'TEXT', exprKind: 'text', derivable: false, secret: true,
    def: (f) => f.def, coerce: (raw) => (raw === undefined ? null : String(raw)), validate: () => null,
    format: () => '', input: (f, v, { row }) => `<input type="password" id="f_${f.name}" name="${f.name}" value=""${f.required && !row?.id ? ' required' : ''}>` },
};
