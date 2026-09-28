// Storage. The schema is derived from /data, never written by hand; a migration
// is the diff between the graph and the live table. Destructive steps need a marker.
// Derived fields never touch the schema: they are computed on every read.
import { DatabaseSync } from 'node:sqlite';
import { parseField, sqlType, defaultValue, coerce, isStored, toExpr, fromExpr } from './spec.mjs';
import { evaluate } from './expr.mjs';
import { hashPassword, isHashed } from './auth.mjs';
import { DEFAULT } from './registry.mjs';
import * as query from './store/query.mjs';
import * as state from './store/state.mjs';
import * as rules from './store/rules.mjs';

export class Store {
  constructor(graph, file, registry = DEFAULT) {
    this.graph = graph;
    this.registry = registry;
    this.db = new DatabaseSync(file);
    this.fields = {};
    for (const [entity, spec] of Object.entries(graph.data)) {
      this.fields[entity] = Object.entries(spec).map(([n, s]) => parseField(n, s, registry.fields, registry.functions));
    }
    this.migrations = [];
    // No-op until createInterpreter() installs the real request-trace sink
    // (item 20: "a guard installed into the store by interp at boot" — the
    // guard itself, checkRules below, is unconditional from construction, so
    // a seed row is checked before interp even exists; only the trace sink
    // needs installing later). ruleExprs caches a rule's parsed expression.
    this.trace = () => {};
    this.ruleExprs = new Map();
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
    // Sessions: the cookie names a row here, so signing out really ends the session.
    this.db.exec(`CREATE TABLE IF NOT EXISTS "_session" (id TEXT PRIMARY KEY, user INTEGER, at TEXT)`);
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
    if (!refs.length) return null;
    throw new Error(`${child} references ${parent} through ${refs.map((f) => f.name).join(' and ')}; name one: ${child}.${refs[0].name}`);
  }

  // A write is a write: a step, a seed and a form all meet the same declared kind.
  // Without this, "closed set" means "closed on the form route only".
  checkValue(entity, f, v) {
    const bad = f.type.validate(v, f, this);
    if (bad) throw new Error(bad);
    return v;
  }

  static prepareValue(f, v) {
    if (f.type.secret) return v === null || v === '' || v === undefined ? null : isHashed(v) ? v : hashPassword(String(v));
    return coerce(f, v);
  }

  insert(entity, values) {
    const cols = [], vals = [];
    for (const f of this.fields[entity].filter(isStored)) {
      const given = values[f.name];
      const use = given === undefined || given === '' ? defaultValue(f) : Store.prepareValue(f, this.checkValue(entity, f, given));
      if (f.required && (use === null || use === undefined || use === '')) throw new Error(`${f.name} is required`);
      cols.push(`"${f.name}"`);
      vals.push(use);
    }
    // The guard: every insert meets rules here, whatever wrote it (item 20).
    const problems = this.checkRules(entity, values, null);
    if (problems.length) throw new Error(problems[0]);
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
      if (f.type.secret && (v === '' || v === undefined || v === null)) continue;
      // A blank box means the declared default, on an edit exactly as on a create.
      const use = v === undefined || v === '' ? defaultValue(f) : Store.prepareValue(f, this.checkValue(entity, f, v));
      if (f.required && (use === null || use === undefined || use === '')) throw new Error(`${f.name} is required`);
      sets.push(`"${k}"=?`); vals.push(use);
    }
    if (!sets.length) return;
    // The guard: every update meets rules here too, against the row as it
    // would be stored (existing row + these values) — item 20.
    const problems = this.checkRules(entity, values, this.raw(entity, id));
    if (problems.length) throw new Error(problems[0]);
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
    // Two logins that differ only in case are one login.
    const sql = f?.type.exprKind === 'text' && typeof v === 'string'
      ? `SELECT id FROM "${entity.toLowerCase()}" WHERE LOWER("${field}")=LOWER(?) AND id!=?`
      : `SELECT id FROM "${entity.toLowerCase()}" WHERE "${field}"=? AND id!=?`;
    return Boolean(this.db.prepare(sql).get(v, Number(excludeId ?? 0)));
  }

  // Compound uniqueness: does another row already have this exact combination?
  // `stored` holds already-storage-form values (interp.mjs's "probe"), never raw
  // submitted text — unlike exists() above, this never re-coerces them.
  existsAll(entity, names, stored, excludeId = null) {
    const conds = names.map((n) => `"${n}"=?`).join(' AND ');
    const vals = names.map((n) => stored[n]);
    const sql = `SELECT id FROM "${entity.toLowerCase()}" WHERE ${conds} AND id!=?`;
    return Boolean(this.db.prepare(sql).get(...vals, Number(excludeId ?? 0)));
  }

  count(entity, where = {}) { return this.list(entity, { where }).length; }

  transaction(fn) {
    this.db.exec('BEGIN');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // --- derived fields ----------------------------------------------------------
  // The evaluation context of a row: field reads (money in major units), one hop
  // through references, and the child rows an aggregate walks. `allowSecret` is
  // for a rule check on the row's own submitted values (still plain text, not yet
  // hashed, and never stored): it does not propagate through a hop or an
  // aggregate, so a referenced row's real password hash stays unreadable.
  ctx(entity, row, stack = [], { allowSecret = false } = {}) {
    const store = this;
    return {
      entity, row,
      get(path) {
        const [head, ...rest] = path;
        // "id" is read-only and always there (docs/FORMAT.md's «Expressions»): it is
        // never a declared field, so it is resolved here rather than looked up below.
        if (head === 'id') {
          if (rest.length) throw new Error(`${entity}.id is a number, cannot read .${rest[0]} of it`);
          return row.id;
        }
        const f = store.field(entity, head);
        if (!f) throw new Error(`${entity} has no field "${head}"`);
        // A password hash is not a value the algebra may copy into an ordinary column.
        if (f.type.secret && !allowSecret) throw new Error(`${entity}.${head} is secret; expressions cannot read it`);
        const v = toExpr(f, f.derive ? store.derived(entity, row, f, stack) : row[head]);
        if (!rest.length) return v;
        if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
        const target = store.raw(f.target, v);
        return target ? store.ctx(f.target, target, stack).get(rest) : null;
      },
      rows(child, via) {
        const link = store.childVia(child, entity, via);
        return store.listRaw(child, { where: link ? { [link]: row.id } : {} }).map((r) => store.ctx(child, r, stack));
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
    return fromExpr(f, evaluate(f.derive, this.ctx(entity, row, [...stack, key]), this.registry.functions));
  }

  hydrate(entity, row) {
    if (!row) return row;
    const out = { ...row };
    for (const f of this.fields[entity]) if (f.derive) out[f.name] = this.derived(entity, row, f);
    return out;
  }
}

// Queries/aggregation (runtime/store/query.mjs), the outbox/session tables
// (runtime/store/state.mjs) and rule enforcement (runtime/store/rules.mjs)
// are plain functions run with `this` bound to the Store instance — split
// out only to keep this file under the size budget; they are as much "the
// store" as anything above.
Object.assign(Store.prototype, query, state, rules);

