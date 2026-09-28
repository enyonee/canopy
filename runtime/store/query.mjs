// The query and aggregation engine, attached to Store.prototype by store.mjs
// (so every function here runs with `this` bound to the Store instance —
// `this.db`, `this.field(...)`, `this.fields[...]`). Structured query only:
// the graph names fields and comparisons, never SQL.
import { coerce } from '../spec.mjs';

const OPS = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' };
// What the user typed is what is searched for: "50%" is a percent sign, not "anything".
const likeSafe = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const UNITS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };

// where: { field: value } is equality; { field: { gte, lte, gt, lt, ne, in, like } } is a range.
export function clauses(entity, where) {
  const clauses = [], vals = [], later = [];
  for (const [field, cmp] of Object.entries(where)) {
    if (cmp === undefined || cmp === '') continue;
    const f = field === 'id' ? { kind: 'int', type: this.registry.fields.int } : this.field(entity, field);
    if (f?.derive) { later.push([field, cmp]); continue; }
    if (cmp === null) { clauses.push(`"${field}" IS NULL`); continue; }
    if (typeof cmp === 'object' && !Array.isArray(cmp)) {
      for (const [op, v] of Object.entries(cmp)) {
        // { ne: null } is IS NOT NULL, item 16's fix — every other op ignores a
        // literal null (the checker refuses one being written at all; see check/scope.mjs).
        if (op === 'ne' && v === null) { clauses.push(`"${field}" IS NOT NULL`); continue; }
        if (v === undefined || v === '' || v === null) continue;
        if (op === 'in') { const arr = Array.isArray(v) ? v : [v]; clauses.push(`"${field}" IN (${arr.map(() => '?').join(',')})`); arr.forEach((x) => vals.push(coerce(f, x))); }
        else if (op === 'like') { clauses.push(`LOWER("${field}") LIKE ? ESCAPE '\\'`); vals.push(`%${likeSafe(String(v).toLowerCase())}%`); }
        else if (OPS[op]) { clauses.push(`"${field}" ${OPS[op]} ?`); vals.push(coerce(f, v)); }
        else throw new Error(`unknown comparison "${op}" on ${entity}.${field}; known: ${Object.keys(OPS).join(', ')}, in, like`);
      }
      continue;
    }
    clauses.push(`"${field}"=?`);
    vals.push(coerce(f, cmp));
  }
  return { clauses, vals, later };
}

// The in-memory twin of a where clause, for derived fields: values compare in storage units.
function matches(row, field, cmp, f = null) {
  const v = row[field];
  const c = (x) => (f ? coerce(f, x) : x);
  if (cmp === null) return v === null;
  if (typeof cmp === 'object' && !Array.isArray(cmp)) {
    return Object.entries(cmp).every(([op, x]) => {
      if (op === 'ne' && x === null) return v !== null;
      if (x === undefined || x === '' || x === null) return true;
      if (op === 'in') return (Array.isArray(x) ? x : [x]).map((y) => String(c(y))).includes(String(v));
      if (op === 'like') return String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
      if (op === 'gte') return v >= c(x); if (op === 'lte') return v <= c(x);
      if (op === 'gt') return v > c(x); if (op === 'lt') return v < c(x);
      if (op === 'ne') return String(v) !== String(c(x));
      throw new Error(`unknown comparison "${op}"; known: ${Object.keys(OPS).join(', ')}, in, like`);
    });
  }
  return String(v) === String(c(cmp));
}

export function listRaw(entity, { search = [], q = '', where = {}, sort = null } = {}) {
  const table = entity.toLowerCase();
  const { clauses: cls, vals } = this.clauses(entity, where);
  if (q && search.length) {
    cls.push('(' + search.map((f) => `LOWER("${f}") LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    search.forEach(() => vals.push(`%${likeSafe(q.toLowerCase())}%`));
  }
  const sortField = sort ? this.field(entity, sort.field) : null;
  const order = sort && !sortField?.derive ? `ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}` : 'ORDER BY id DESC';
  return this.db.prepare(
    `SELECT * FROM "${table}"${cls.length ? ' WHERE ' + cls.join(' AND ') : ''} ${order}`).all(...vals);
}

export function list(entity, opts = {}) {
  let rows = this.listRaw(entity, opts).map((r) => this.hydrate(entity, r));
  const { later } = this.clauses(entity, opts.where || {});
  for (const [field, cmp] of later) rows = rows.filter((r) => matches(r, field, cmp, this.field(entity, field)));
  const sort = opts.sort;
  if (sort && this.field(entity, sort.field)?.derive) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => (a[sort.field] > b[sort.field] ? dir : a[sort.field] < b[sort.field] ? -dir : 0));
  }
  return rows;
}

// Declarative aggregation: the graph names the function and the field, never SQL.
// groupUnit (day | month | year) buckets a date or time field.
export function aggregate(entity, { groupBy = null, groupUnit = null, metrics = [], sort = null, limit = null, where = {} } = {}) {
  const usesDerived = (groupBy && this.field(entity, groupBy)?.derive) || metrics.some((m) => m.field && this.field(entity, m.field)?.derive)
    || this.clauses(entity, where).later.length;
  if (usesDerived) return this.aggregateInMemory(entity, { groupBy, groupUnit, metrics, sort, limit, where });
  const table = entity.toLowerCase();
  const cols = [];
  if (groupBy) cols.push(groupUnit ? `strftime('${UNITS[groupUnit]}', "${groupBy}") AS grp` : `"${groupBy}" AS grp`);
  for (const m of metrics) {
    const fn = String(m.fn).toUpperCase();
    const expr = fn === 'COUNT' ? 'COUNT(*)' : `${fn}("${m.field}")`;
    cols.push(`${expr} AS "${m.as}"`);
  }
  const { clauses: cls, vals } = this.clauses(entity, where);
  let sql = `SELECT ${cols.join(', ')} FROM "${table}"`;
  if (cls.length) sql += ` WHERE ${cls.join(' AND ')}`;
  if (groupBy) sql += ' GROUP BY grp';
  if (sort) sql += ` ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;
  return this.db.prepare(sql).all(...vals).map((r) => ({ ...r }));
}

export function aggregateInMemory(entity, { groupBy, groupUnit, metrics, sort, limit, where }) {
  const rows = this.list(entity, { where });
  const bucket = (v) => (groupUnit && v ? String(v).slice(0, { day: 10, month: 7, year: 4 }[groupUnit]) : v);
  const groups = new Map();
  for (const r of rows) {
    const key = groupBy ? bucket(r[groupBy]) : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let out = [...groups.entries()].map(([grp, rs]) => {
    const o = groupBy ? { grp } : {};
    for (const m of metrics) {
      const vals = rs.map((r) => r[m.field]).filter((v) => v !== null && v !== undefined);
      o[m.as] = m.fn === 'count' ? rs.length : !vals.length ? null
        : m.fn === 'sum' ? vals.reduce((a, b) => a + b, 0)
        : m.fn === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length
        : m.fn === 'min' ? Math.min(...vals) : Math.max(...vals);
    }
    return o;
  });
  if (sort) { const d = sort.dir === 'asc' ? 1 : -1; out.sort((a, b) => (a[sort.field] > b[sort.field] ? d : a[sort.field] < b[sort.field] ? -d : 0)); }
  if (limit) out = out.slice(0, Number(limit));
  return out;
}
