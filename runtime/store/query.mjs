// The query and aggregation engine, attached to Store.prototype by store.mjs
// (so every function here runs with `this` bound to the Store instance —
// `this.drv`, `this.field(...)`, `this.fields[...]`). Structured query only:
// the graph names fields and comparisons, never SQL.
import { coerce, sqlType } from '../spec.mjs';

const OPS = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' };
const DEFAULT_PAGE_SIZE = 50;

// where: { field: value } is equality; { field: { gte, lte, gt, lt, ne, in, like } } is a range.
export function clauses(entity, where) {
  const { quote: q, ph, phs, like, likeArg } = this.drv.dialect;
  const clauses = [], vals = [], later = [];
  for (const [field, cmp] of Object.entries(where)) {
    if (cmp === undefined || cmp === '') continue;
    const f = field === 'id' ? { kind: 'int', type: this.registry.fields.int } : this.field(entity, field);
    if (f?.derive) { later.push([field, cmp]); continue; }
    if (cmp === null) { clauses.push(`${q(field)} IS NULL`); continue; }
    if (typeof cmp === 'object' && !Array.isArray(cmp)) {
      for (const [op, v] of Object.entries(cmp)) {
        // { ne: null } is IS NOT NULL, item 16's fix — every other op ignores a
        // literal null (the checker refuses one being written at all; see check/scope.mjs).
        if (op === 'ne' && v === null) { clauses.push(`${q(field)} IS NOT NULL`); continue; }
        if (v === undefined || v === '' || v === null) continue;
        if (op === 'in') { const arr = Array.isArray(v) ? v : [v]; clauses.push(`${q(field)} IN (${phs(arr.length, vals.length + 1)})`); arr.forEach((x) => vals.push(coerce(f, x))); }
        else if (op === 'like') { clauses.push(like(q(field), ph(vals.length + 1))); vals.push(likeArg(v)); }
        else if (OPS[op]) { clauses.push(`${q(field)} ${OPS[op]} ${ph(vals.length + 1)}`); vals.push(coerce(f, v)); }
        else throw new Error(`unknown comparison "${op}" on ${entity}.${field}; known: ${Object.keys(OPS).join(', ')}, in, like`);
      }
      continue;
    }
    clauses.push(`${q(field)}=${ph(vals.length + 1)}`);
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

// The WHERE fragment (SQL text + bound values) shared by every raw read below:
// the structured `where`, plus the free-text "q" over "search"'s field list.
function buildWhere(store, entity, { search = [], q = '', where = {} } = {}) {
  const { clauses: cls, vals } = store.clauses(entity, where);
  const { quote, ph, like, likeArg } = store.drv.dialect;
  if (q && search.length) {
    cls.push('(' + search.map((f) => { vals.push(likeArg(q)); return like(quote(f), ph(vals.length)); }).join(' OR ') + ')');
  }
  return { sql: cls.length ? ` WHERE ${cls.join(' AND ')}` : '', vals };
}

const isText = (f) => Boolean(f && sqlType(f).startsWith('TEXT'));

// ORDER BY a real column (never a derived one — the caller falls back to a
// full in-memory sort for those, matches() above's twin).
function orderBy(store, entity, sort) {
  const sortField = sort ? store.field(entity, sort.field) : null;
  const { quote, order } = store.drv.dialect;
  return sort && !sortField?.derive
    ? `ORDER BY ${order(quote(sort.field), sort.dir === 'asc' ? 'ASC' : 'DESC', { text: isText(sortField), tie: true })}` : 'ORDER BY id DESC';
}

export function listRaw(entity, opts = {}) {
  const { sql, vals } = buildWhere(this, entity, opts);
  return this.drv.all(`SELECT * FROM ${this.drv.dialect.quote(entity.toLowerCase())}${sql} ${orderBy(this, entity, opts.sort)}`, vals);
}

// A page of raw (un-hydrated) rows, in the same order listRaw would give —
// its first `limit`, starting at `offset`. Used only when no derived sort or
// in-memory ("later") where forces the full-scan path (query.mjs's listPage).
export function listRawPage(entity, opts, limit, offset) {
  const { sql, vals } = buildWhere(this, entity, opts);
  const { quote, ph } = this.drv.dialect;
  return this.drv.all(`SELECT * FROM ${quote(entity.toLowerCase())}${sql} ${orderBy(this, entity, opts.sort)} LIMIT ${ph(vals.length + 1)} OFFSET ${ph(vals.length + 2)}`, [...vals, limit, offset]);
}

// How many rows would match, without fetching or hydrating any of them.
export function countRaw(entity, opts = {}) {
  const { sql, vals } = buildWhere(this, entity, opts);
  return Number(this.drv.get(`SELECT COUNT(*) AS n FROM ${this.drv.dialect.quote(entity.toLowerCase())}${sql}`, vals).n);
}

// Bound well under SQLite's own SQLITE_MAX_VARIABLE_NUMBER (32766 since
// 3.32.0, as little as 999 before it — never assume the higher number) and
// under engines that choke on spreading a huge array of bound values before
// that. A full-table hydrate (CSV of a big table) or a single page whose rows
// fan out wide enough can each alone put more than that many parent ids into
// one prefetch.
const IN_CHUNK = 5000;

// Every row of `entity` whose `via` column names one of `ids` — as few
// queries as `ids.length` allows within IN_CHUNK, in the same order a plain
// `listRaw` would give any one parent's children (`ORDER BY id DESC`, item
// C's fix — the unbatched path this replaces never sorted any other way, and
// a batched sum/avg must accumulate its floats in the same order or the last
// digit can differ). `via` is always a `ref` field, stored as TEXT
// (runtime/fields.mjs's ref.sql) — `clauses()` always coerces a ref
// comparison's value through `coerce()` (= String) before binding it, and an
// unrelated bound INTEGER does not get SQLite's column-affinity treatment the
// way a bare `=` would, so an IN-list of raw numeric ids would silently match
// nothing. Never cached (`{ cache: false }`): the chunk
// boundary varies with `ids.length`, so the SQL text rarely repeats, and
// caching it would only evict statements that do.
export function listRawIn(entity, via, ids) {
  if (!ids.length) return [];
  const { quote, phs } = this.drv.dialect;
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const vals = ids.slice(i, i + IN_CHUNK).map(String);
    const sql = `SELECT * FROM ${quote(entity.toLowerCase())} WHERE ${quote(via)} IN (${phs(vals.length)}) ORDER BY id DESC`;
    out.push(...this.drv.all(sql, vals, { cache: false }));
  }
  return out;
}

// The rows of `entity` with these ids (`keys`: numeric strings, see snapshot.mjs's refKey), in as
// few queries as IN_CHUNK allows — one level of a reference hop. Never cached, like listRawIn.
export function listRawByIds(entity, keys) {
  const { quote, phs } = this.drv.dialect;
  const out = [];
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const vals = keys.slice(i, i + IN_CHUNK).map(Number);
    out.push(...this.drv.all(`SELECT * FROM ${quote(entity.toLowerCase())} WHERE id IN (${phs(vals.length)})`, vals, { cache: false }));
  }
  return out;
}

// The cheap twin of `label(entity, get(entity, id))`: a label never needs any
// field but the label field itself, so this reads the raw row (no children,
// no other derived field) and derives only that one field, only if it is
// derived at all. Every "render a reference as its label" site (a ref cell in
// a list/detail/CSV, a dashboard's ref groupBy) must call this, not `get()` +
// `label()` — hydrating the whole target row costs as much as its most
// expensive derived field even when the label is a plain stored column
// (tests/arch.test.mjs's "no ref-label site re-hydrates…" gate enforces it).
export function labelOf(entity, id) {
  const row = this.raw(entity, id);
  if (!row) return '';
  const lf = this.labelField(entity);
  if (!lf) return `#${row.id}`;
  const f = this.field(entity, lf);
  const v = f.derive ? this.deriveOne(entity, row, f) : row[lf];
  return v ? String(v) : `#${row.id}`;
}

export function list(entity, opts = {}) {
  let rows = this.hydratePage(entity, this.listRaw(entity, opts));
  const { later } = this.clauses(entity, opts.where || {});
  for (const [field, cmp] of later) rows = rows.filter((r) => matches(r, field, cmp, this.field(entity, field)));
  const sort = opts.sort;
  if (sort && this.field(entity, sort.field)?.derive) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => (a[sort.field] > b[sort.field] ? dir : a[sort.field] < b[sort.field] ? -dir : 0));
  }
  return rows;
}

// Page-before-hydrate (item 2): when neither an in-memory ("later") where nor
// a derived-field sort forces a full scan, SQL itself counts and pages the
// rows, and only the page's own rows are ever hydrated (batched — item 3).
// Otherwise this falls back to list()'s full, already-batched hydrate, then
// slices in memory — identical result, just not cheaper than before.
export function listPage(entity, opts = {}, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const { later } = this.clauses(entity, opts.where || {});
  const sortField = opts.sort ? this.field(entity, opts.sort.field) : null;
  if (later.length || sortField?.derive) {
    const rows = this.list(entity, opts);
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const at = Math.min(Math.max(1, page), pages);
    return { rows: rows.slice((at - 1) * pageSize, at * pageSize), total: rows.length, page: at, pages };
  }
  const total = this.countRaw(entity, opts);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const at = Math.min(Math.max(1, page), pages);
  const raw = this.listRawPage(entity, opts, pageSize, (at - 1) * pageSize);
  return { rows: this.hydratePage(entity, raw), total, page: at, pages };
}

// Batched aggregate hydration (buildAggCache, aggValue, hydratePage) lives in
// runtime/store/hydrate.mjs — kept out of this file only to stay under the
// module line budget; it is attached to the same Store.prototype and calls
// straight back into listRaw/listRawIn/childVia/hydrate above via `this`.

// Declarative aggregation: the graph names the function and the field, never SQL.
// groupUnit (day | month | year) buckets a date or time field.
export function aggregate(entity, { groupBy = null, groupUnit = null, metrics = [], sort = null, limit = null, where = {} } = {}) {
  const usesDerived = (groupBy && this.field(entity, groupBy)?.derive) || metrics.some((m) => m.field && this.field(entity, m.field)?.derive)
    || this.clauses(entity, where).later.length;
  if (usesDerived) return this.aggregateInMemory(entity, { groupBy, groupUnit, metrics, sort, limit, where });
  const { quote: q, bucket, order, collate } = this.drv.dialect;
  const cols = [];
  if (groupBy) {
    const grp = groupUnit ? bucket(q(groupBy), groupUnit) : q(groupBy);
    cols.push(`${groupUnit || isText(this.field(entity, groupBy)) ? collate(grp) : grp} AS grp`);
  }
  for (const m of metrics) {
    const fn = String(m.fn).toUpperCase();
    const expr = fn === 'COUNT' ? 'COUNT(*)' : `${fn}(${q(m.field)})`;
    cols.push(`${expr} AS ${q(m.as)}`);
  }
  const { clauses: cls, vals } = this.clauses(entity, where);
  let sql = `SELECT ${cols.join(', ')} FROM ${q(entity.toLowerCase())}`;
  if (cls.length) sql += ` WHERE ${cls.join(' AND ')}`;
  if (groupBy) sql += ' GROUP BY grp';
  if (sort) sql += ` ORDER BY ${order(q(sort.field), sort.dir === 'asc' ? 'ASC' : 'DESC')}`;
  if (limit) sql += ` LIMIT ${Number(limit)}`;
  return this.drv.all(sql, vals).map((r) => ({ ...r }));
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
