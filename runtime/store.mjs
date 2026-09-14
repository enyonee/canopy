// Storage. The schema is derived from /data, never written by hand; a migration
// is the diff between the graph and the live table. Destructive steps need a marker.
// Derived fields never touch the schema: they are computed on every read.
import { DatabaseSync } from 'node:sqlite';
import { parseField, sqlType, defaultValue, coerce, isStored, toMajor, toMinor, exprKind } from './spec.mjs';
import { evaluate } from './expr.mjs';
import { hashPassword, isHashed } from './auth.mjs';

const OPS = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' };
const UNITS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };

export class Store {
  constructor(graph, file) {
    this.graph = graph;
    this.db = new DatabaseSync(file);
    this.fields = {};
    for (const [entity, spec] of Object.entries(graph.data)) {
      this.fields[entity] = Object.entries(spec).map(([n, s]) => parseField(n, s));
    }
    this.migrations = [];
    this.migrate();
  }

  migrate() {
    for (const [entity, fields] of Object.entries(this.fields)) {
      const table = entity.toLowerCase();
      const stored = fields.filter(isStored);
      const existing = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!existing) {
        const cols = stored.map((f) => `"${f.name}" ${sqlType(f)}`).join(', ');
        this.db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT${cols ? ', ' + cols : ''})`);
        this.migrations.push(`create table ${table}`);
        continue;
      }
      const live = this.db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
      for (const f of stored) {
        if (live.includes(f.name)) continue;
        this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${f.name}" ${sqlType(f)}`);
        // A declared default is a promise about every row, not only new ones.
        const seed = defaultValue(f);
        if (seed !== null) {
          const n = this.db.prepare(
            `UPDATE "${table}" SET "${f.name}"=? WHERE "${f.name}" IS NULL`).run(seed).changes;
          this.migrations.push(`add column ${table}.${f.name} (+ backfilled ${n} row(s) with ${JSON.stringify(seed)})`);
        } else this.migrations.push(`add column ${table}.${f.name}`);
      }
      const declared = stored.map((f) => f.name);
      const orphan = live.filter((c) => c !== 'id' && !declared.includes(c));
      if (orphan.length && !this.graph.allowDestructive) {
        this.migrations.push(`kept orphan columns ${orphan.join(', ')} (destructive change needs "allowDestructive": true)`);
      }
    }
    // The outbox: every effect that leaves the process is a row here first.
    this.db.exec(`CREATE TABLE IF NOT EXISTS "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, connector TEXT,
      target TEXT, payload TEXT, status TEXT, code INTEGER, error TEXT, attempts INTEGER DEFAULT 0, at TEXT, updatedAt TEXT)`);
  }

  field(entity, name) { return (this.fields[entity] || []).find((f) => f.name === name); }

  // Display name of a row: the entity's first plain text field, or #id.
  labelField(entity) {
    const f = (this.fields[entity] || []).find((x) => x.kind === 'text');
    return f ? f.name : null;
  }
  label(entity, row) {
    if (!row) return '';
    const lf = this.labelField(entity);
    return lf && row[lf] ? String(row[lf]) : `#${row.id}`;
  }

  // The single reference field of `child` that points at `parent` — the reverse
  // edge aggregates walk. Ambiguity is an error the graph resolves by naming it.
  childVia(child, parent, via = null) {
    const refs = (this.fields[child] || []).filter((f) => f.kind === 'ref' && f.target === parent);
    if (via) {
      const f = this.field(child, via);
      if (!f || f.kind !== 'ref' || f.target !== parent) throw new Error(`${child}.${via} is not a reference to ${parent}`);
      return via;
    }
    if (!this.fields[child]) throw new Error(`unknown entity "${child}"`);
    if (refs.length === 1) return refs[0].name;
    if (!refs.length) throw new Error(`${child} has no reference to ${parent}; add a "ref:${parent}" field to ${child}`);
    throw new Error(`${child} references ${parent} through ${refs.map((f) => f.name).join(' and ')}; name one: ${child}.${refs[0].name}`);
  }

  static prepareValue(f, v) {
    if (f.kind === 'password') return v === null || v === '' || v === undefined ? null : isHashed(v) ? v : hashPassword(String(v));
    return coerce(f, v);
  }

  insert(entity, values) {
    const cols = [], vals = [];
    for (const f of this.fields[entity].filter(isStored)) {
      const given = values[f.name];
      cols.push(`"${f.name}"`);
      vals.push(given === undefined || given === '' ? defaultValue(f) : Store.prepareValue(f, given));
    }
    const st = this.db.prepare(cols.length
      ? `INSERT INTO "${entity.toLowerCase()}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      : `INSERT INTO "${entity.toLowerCase()}" DEFAULT VALUES`);
    return Number(st.run(...vals).lastInsertRowid);
  }

  update(entity, id, values) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(values)) {
      const f = this.field(entity, k);
      if (!f || !isStored(f)) continue;
      // An empty password on edit means "keep the old one", never "erase it".
      if (f.kind === 'password' && (v === '' || v === undefined || v === null)) continue;
      sets.push(`"${k}"=?`); vals.push(Store.prepareValue(f, v));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE "${entity.toLowerCase()}" SET ${sets.join(',')} WHERE id=?`).run(...vals, Number(id));
  }

  remove(entity, id) {
    this.db.prepare(`DELETE FROM "${entity.toLowerCase()}" WHERE id=?`).run(Number(id));
  }

  raw(entity, id) {
    if (id === undefined || id === null || id === '') return null;
    return this.db.prepare(`SELECT * FROM "${entity.toLowerCase()}" WHERE id=?`).get(Number(id));
  }

  get(entity, id) { return this.hydrate(entity, this.raw(entity, id)); }

  exists(entity, field, value, excludeId = null) {
    const f = this.field(entity, field);
    const v = coerce(f, value);
    const row = this.db.prepare(`SELECT id FROM "${entity.toLowerCase()}" WHERE "${field}"=? AND id!=?`).get(v, Number(excludeId ?? 0));
    return Boolean(row);
  }

  count(entity, where = {}) { return this.list(entity, { where }).length; }

  transaction(fn) {
    this.db.exec('BEGIN');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // --- derived fields ----------------------------------------------------------
  // The evaluation context of a row: field reads (money in major units), one hop
  // through references, and the child rows an aggregate walks.
  ctx(entity, row, stack = []) {
    const store = this;
    return {
      entity, row,
      get(path) {
        const [head, ...rest] = path;
        const f = store.field(entity, head);
        if (!f) throw new Error(`${entity} has no field "${head}"`);
        let v = f.derive ? store.derived(entity, row, f, stack) : row[head];
        if (f.kind === 'money') v = toMajor(v);
        if (f.kind === 'bool') v = Boolean(v);
        if (!rest.length) return v;
        if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
        const target = store.raw(f.target, v);
        return target ? store.ctx(f.target, target, stack).get(rest) : null;
      },
      rows(child, via) {
        const link = store.childVia(child, entity, via);
        return store.listRaw(child, { where: { [link]: row.id } }).map((r) => store.ctx(child, r, stack));
      },
    };
  }

  // The field a dotted path ends in, following references; null when it leads nowhere.
  fieldAt(entity, path) {
    let cur = entity, f = null;
    for (const seg of path) {
      f = this.field(cur, seg);
      if (!f) return null;
      cur = f.kind === 'ref' ? f.target : null;
    }
    return f;
  }

  derived(entity, row, f, stack = []) {
    const key = `${entity}.${f.name}`;
    if (stack.includes(key)) throw new Error(`derived field ${key} depends on itself (${[...stack, key].join(' → ')})`);
    const v = evaluate(f.derive, this.ctx(entity, row, [...stack, key]));
    if (f.kind === 'money') return v === null || v === undefined ? null : toMinor(v);
    if (f.kind === 'bool') return v ? 1 : 0;
    if (f.kind === 'int') return v === null || v === undefined ? null : Math.round(v);
    return v === undefined ? null : v;
  }

  hydrate(entity, row) {
    if (!row) return row;
    const out = { ...row };
    for (const f of this.fields[entity]) if (f.derive) out[f.name] = this.derived(entity, row, f);
    return out;
  }

  // --- queries -------------------------------------------------------------------
  // Structured query only: the graph names fields and comparisons, never SQL.
  // where: { field: value } is equality; { field: { gte, lte, gt, lt, ne, in, like } } is a range.
  clauses(entity, where) {
    const clauses = [], vals = [], later = [];
    for (const [field, cmp] of Object.entries(where)) {
      if (cmp === undefined || cmp === '') continue;
      const f = this.field(entity, field);
      if (f?.derive) { later.push([field, cmp]); continue; }
      if (cmp === null) { clauses.push(`"${field}" IS NULL`); continue; }
      if (typeof cmp === 'object' && !Array.isArray(cmp)) {
        for (const [op, v] of Object.entries(cmp)) {
          if (v === undefined || v === '' || v === null) continue;
          if (op === 'in') { const arr = Array.isArray(v) ? v : [v]; clauses.push(`"${field}" IN (${arr.map(() => '?').join(',')})`); arr.forEach((x) => vals.push(coerce(f, x))); }
          else if (op === 'like') { clauses.push(`LOWER("${field}") LIKE ?`); vals.push(`%${String(v).toLowerCase()}%`); }
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
  static matches(row, field, cmp, f = null) {
    const v = row[field];
    const c = (x) => (f ? coerce(f, x) : x);
    if (cmp === null) return v === null;
    if (typeof cmp === 'object' && !Array.isArray(cmp)) {
      return Object.entries(cmp).every(([op, x]) => {
        if (x === undefined || x === '' || x === null) return true;
        if (op === 'in') return (Array.isArray(x) ? x : [x]).map((y) => String(c(y))).includes(String(v));
        if (op === 'like') return String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
        if (op === 'gte') return v >= c(x); if (op === 'lte') return v <= c(x);
        if (op === 'gt') return v > c(x); if (op === 'lt') return v < c(x);
        return String(v) !== String(c(x));
      });
    }
    return String(v) === String(c(cmp));
  }

  listRaw(entity, { search = [], q = '', where = {}, sort = null } = {}) {
    const table = entity.toLowerCase();
    const { clauses, vals } = this.clauses(entity, where);
    if (q && search.length) {
      clauses.push('(' + search.map((f) => `LOWER("${f}") LIKE ?`).join(' OR ') + ')');
      search.forEach(() => vals.push(`%${q.toLowerCase()}%`));
    }
    const sortField = sort ? this.field(entity, sort.field) : null;
    const order = sort && !sortField?.derive ? `ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}` : 'ORDER BY id DESC';
    return this.db.prepare(
      `SELECT * FROM "${table}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ${order}`).all(...vals);
  }

  list(entity, opts = {}) {
    let rows = this.listRaw(entity, opts).map((r) => this.hydrate(entity, r));
    const { later } = this.clauses(entity, opts.where || {});
    for (const [field, cmp] of later) rows = rows.filter((r) => Store.matches(r, field, cmp, this.field(entity, field)));
    const sort = opts.sort;
    if (sort && this.field(entity, sort.field)?.derive) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      rows.sort((a, b) => (a[sort.field] > b[sort.field] ? dir : a[sort.field] < b[sort.field] ? -dir : 0));
    }
    return rows;
  }

  // Declarative aggregation: the graph names the function and the field, never SQL.
  // groupUnit (day | month | year) buckets a date or time field.
  aggregate(entity, { groupBy = null, groupUnit = null, metrics = [], sort = null, limit = null, where = {} } = {}) {
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
    const { clauses, vals } = this.clauses(entity, where);
    let sql = `SELECT ${cols.join(', ')} FROM "${table}"`;
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    if (groupBy) sql += ' GROUP BY grp';
    if (sort) sql += ` ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}`;
    if (limit) sql += ` LIMIT ${Number(limit)}`;
    return this.db.prepare(sql).all(...vals).map((r) => ({ ...r }));
  }

  aggregateInMemory(entity, { groupBy, groupUnit, metrics, sort, limit, where }) {
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

  // --- outbox ----------------------------------------------------------------------
  enqueue({ kind, connector, target, payload }) {
    const at = new Date().toISOString();
    return Number(this.db.prepare(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts, at, updatedAt)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`).run(kind, connector, target, JSON.stringify(payload ?? null), at, at).lastInsertRowid);
  }
  outbox(where = {}) {
    const clauses = [], vals = [];
    for (const [k, v] of Object.entries(where)) { clauses.push(`"${k}"=?`); vals.push(v); }
    return this.db.prepare(`SELECT * FROM "_outbox"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC`).all(...vals)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  outboxGet(id) { return this.outbox({ id: Number(id) })[0] || null; }
  outboxUpdate(id, patch) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`"${k}"=?`); vals.push(v); }
    sets.push('"updatedAt"=?'); vals.push(new Date().toISOString());
    this.db.prepare(`UPDATE "_outbox" SET ${sets.join(',')} WHERE id=?`).run(...vals, Number(id));
  }
}

export { exprKind };
