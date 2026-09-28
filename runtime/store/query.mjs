// The query and aggregation engine, attached to Store.prototype by store.mjs
// (so every function here runs with `this` bound to the Store instance —
// `this.db`, `this.field(...)`, `this.fields[...]`). Structured query only:
// the graph names fields and comparisons, never SQL.
import { coerce } from '../spec.mjs';

const OPS = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' };
// What the user typed is what is searched for: "50%" is a percent sign, not "anything".
const likeSafe = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const UNITS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
const DEFAULT_PAGE_SIZE = 50;

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

// The WHERE fragment (SQL text + bound values) shared by every raw read below:
// the structured `where`, plus the free-text "q" over "search"'s field list.
function buildWhere(store, entity, { search = [], q = '', where = {} } = {}) {
  const { clauses: cls, vals } = store.clauses(entity, where);
  if (q && search.length) {
    cls.push('(' + search.map((f) => `LOWER("${f}") LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    search.forEach(() => vals.push(`%${likeSafe(q.toLowerCase())}%`));
  }
  return { sql: cls.length ? ` WHERE ${cls.join(' AND ')}` : '', vals };
}

// ORDER BY a real column (never a derived one — the caller falls back to a
// full in-memory sort for those, matches() above's twin).
function orderBy(store, entity, sort) {
  const sortField = sort ? store.field(entity, sort.field) : null;
  return sort && !sortField?.derive ? `ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}` : 'ORDER BY id DESC';
}

export function listRaw(entity, opts = {}) {
  const { sql, vals } = buildWhere(this, entity, opts);
  return this.prepare(`SELECT * FROM "${entity.toLowerCase()}"${sql} ${orderBy(this, entity, opts.sort)}`).all(...vals);
}

// A page of raw (un-hydrated) rows, in the same order listRaw would give —
// its first `limit`, starting at `offset`. Used only when no derived sort or
// in-memory ("later") where forces the full-scan path (query.mjs's listPage).
export function listRawPage(entity, opts, limit, offset) {
  const { sql, vals } = buildWhere(this, entity, opts);
  return this.prepare(`SELECT * FROM "${entity.toLowerCase()}"${sql} ${orderBy(this, entity, opts.sort)} LIMIT ? OFFSET ?`).all(...vals, limit, offset);
}

// How many rows would match, without fetching or hydrating any of them.
export function countRaw(entity, opts = {}) {
  const { sql, vals } = buildWhere(this, entity, opts);
  return Number(this.prepare(`SELECT COUNT(*) AS n FROM "${entity.toLowerCase()}"${sql}`).get(...vals).n);
}

// Every row of `entity` whose `via` column names one of `ids` — one query,
// however many parents it serves (buildAggCache's prefetch, and anything else
// that needs "the children of a whole batch of rows" in one round trip).
// `via` is always a `ref` field, stored as TEXT (runtime/fields.mjs's
// ref.sql) — `clauses()` always coerces a ref comparison's value through
// `coerce()` (= String) before binding it, and an unrelated bound INTEGER
// does not get SQLite's column-affinity treatment the way a bare `=` would,
// so an IN-list of raw numeric ids would silently match nothing.
export function listRawIn(entity, via, ids) {
  if (!ids.length) return [];
  const vals = ids.map(String);
  return this.prepare(`SELECT * FROM "${entity.toLowerCase()}" WHERE "${via}" IN (${vals.map(() => '?').join(',')})`).all(...vals);
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

// --- batched aggregate hydration (item 3) -------------------------------------
// Every `agg` node directly in scope of the entity being hydrated — not one
// nested inside another aggregate's own body, which is scoped against the
// *child* entity instead and is exactly what the recursive prefetch below
// reaches on its own. `sum(x) + count(y)` yields both; `count(y)`'s own body
// is never descended into here.
function topAggs(node, out = []) {
  if (!node) return out;
  if (node.t === 'agg') { out.push(node); return out; }
  if (node.t === 'bin') { topAggs(node.a, out); topAggs(node.b, out); }
  else if (node.t === 'un') topAggs(node.a, out);
  else if (node.t === 'call') node.args.forEach((a) => topAggs(a, out));
  return out;
}

// Prefetches, for every plain child-aggregate declared directly on `entity`,
// the children of all `ids` in one query each — grouped by parent id — then
// recurses into the child entity with the ids just fetched, so a chain of
// aggregates (a customer's spend, over each order's own total, over each
// order's own items) batches at every level, not only the first. `cache` is
// purely additive: `Store#ctx()`'s `rows()` consults it first and, on a miss
// (no `via` — an aggregate over unrelated/sibling rows, item 3's one
// documented fallback — or an entity already visited, `seen` guarding a
// derived-field cycle same as `Store#derived` does), runs the exact query it
// always would. Correctness never depends on this cache existing.
export function buildAggCache(entity, ids, cache = { groups: new Map() }, seen = new Set()) {
  if (seen.has(entity) || !ids.length) return cache;
  seen.add(entity);
  for (const f of this.fields[entity] || []) {
    if (!f.derive) continue;
    for (const agg of topAggs(f.derive)) {
      const via = this.childVia(agg.entity, entity, agg.via);
      if (!via) continue; // no direct link back — the one case left unbatched
      const key = `${agg.entity}|${via}`;
      if (cache.groups.has(key)) continue;
      const rows = this.listRawIn(agg.entity, via, ids);
      // A `ref` column is stored as TEXT (runtime/fields.mjs's ref.sql), so a
      // child's raw via-value is a string even though the parent's own `id` is
      // a real number (the rowid) — grouped by the string form of both, or
      // every group would come up empty against a SQL-correct (and thus
      // type-coercing) equality that never noticed the mismatch.
      const grouped = new Map(ids.map((id) => [String(id), []]));
      for (const r of rows) grouped.get(String(r[via]))?.push(r);
      cache.groups.set(key, grouped);
      const childIds = rows.map((r) => r.id);
      if (childIds.length) this.buildAggCache(agg.entity, childIds, cache, seen);
    }
  }
  return cache;
}

// Hydrates a whole page of rows of the same entity in a bounded number of
// queries instead of one per row per aggregate derived field: one query per
// distinct (child, via) pair reached from `entity`, at every depth, however
// many rows are on the page.
export function hydratePage(entity, rows) {
  if (!rows.length) return [];
  const cache = this.buildAggCache(entity, rows.map((r) => r.id));
  return rows.map((r) => this.hydrate(entity, r, cache));
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
  return this.prepare(sql).all(...vals).map((r) => ({ ...r }));
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
