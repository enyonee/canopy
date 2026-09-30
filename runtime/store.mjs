// Storage. The schema is derived from /data, never written by hand; a migration
// is the diff between the graph and the live table. Destructive steps need a marker.
// Derived fields never touch the schema: they are computed on every read.
import { parseField, sqlType, defaultValue, coerce, isStored, fromExpr } from './spec.mjs';
import { evaluate } from './expr.mjs';
import { hashPassword, isHashed } from './auth.mjs';
import { DEFAULT } from './registry.mjs';
import { open } from './driver.mjs';
import * as query from './store/query.mjs';
import * as hydrate from './store/hydrate.mjs';
import * as lazy from './store/lazy.mjs';
import * as state from './store/state.mjs';
import * as rules from './store/rules.mjs';
import * as migrate from './store/migrate.mjs';
import { RowCtx, checkCycle } from './store/ctx.mjs';

export class Store {
  constructor(graph, file, registry = DEFAULT, driver = null) {
    this.graph = graph;
    this.registry = registry;
    this.drv = open(driver ?? file);
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
    // Test-only: hydrate over the old lazy RowCtx (runtime/store/lazy.mjs) instead of a snapshot.
    this.lazyEval = false;
    // Read-sets of derived fields (runtime/store/plan.mjs), by entity and field list: pure in the graph.
    this.plans = new Map();
    this.migrate();
  }

  migrate() {
    for (const [entity, fields] of Object.entries(this.fields)) {
      const table = entity.toLowerCase();
      const stored = fields.filter(isStored);
      if (!this.drv.tables().includes(table)) {
        this.drv.createTable(table, stored.map((f) => [f.name, sqlType(f)]));
        this.migrations.push(`create table ${table}`);
        this.migrateIndexes(entity);
        continue;
      }
      const live = this.drv.columns(table).map((r) => r.name);
      for (const f of stored) {
        if (live.includes(f.name)) continue;
        this.drv.addColumn(table, f.name, sqlType(f));
        // A declared default is a promise about every row, not only new ones.
        const seed = defaultValue(f);
        if (seed !== null) {
          const { quote: q, ph } = this.drv.dialect;
          const n = this.drv.run(
            `UPDATE ${q(table)} SET ${q(f.name)}=${ph(1)} WHERE ${q(f.name)} IS NULL`, [seed]).changes;
          this.migrations.push(`add column ${table}.${f.name} (+ backfilled ${n} row(s) with ${JSON.stringify(seed)})`);
        } else this.migrations.push(`add column ${table}.${f.name}`);
      }
      const declared = stored.map((f) => f.name);
      const orphan = live.filter((c) => c !== 'id' && !declared.includes(c));
      if (orphan.length && !this.graph.allowDestructive) {
        this.migrations.push(`kept orphan columns ${orphan.join(', ')} (destructive change needs "allowDestructive": true)`);
      }
      this.migrateIndexes(entity);
    }
    this.migrateOutbox();
    this.migrateInbound();
    // Sessions: the cookie names a row here, so signing out really ends the session.
    this.drv.createTable('_session', [['id', 'TEXT PRIMARY KEY'], ['user', 'INTEGER'], ['at', 'TEXT']], { ifNotExists: true, serial: false });
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
    const bad = f.type.validate(v, f);
    if (bad) throw new Error(bad);
    // A reference must point at a row: the kernel asks the store, a field kind never does.
    if (f.kind === 'ref' && v && !this.raw(f.target, v)) throw new Error(`${f.name}: there is no ${f.target} #${v}`);
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
      cols.push(f.name);
      vals.push(use);
    }
    // The guard: every insert meets rules here, whatever wrote it (item 20).
    const problems = this.checkRules(entity, values, null);
    if (problems.length) throw new Error(problems[0]);
    return this.drv.run(this.drv.dialect.insert(entity.toLowerCase(), cols), vals).lastId;
  }

  update(entity, id, values) {
    const { quote: q, ph } = this.drv.dialect;
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(values)) {
      const f = this.field(entity, k);
      if (!f || !isStored(f)) continue;
      // An empty password on edit means "keep the old one", never "erase it".
      if (f.type.secret && (v === '' || v === undefined || v === null)) continue;
      // A blank box means the declared default, on an edit exactly as on a create.
      const use = v === undefined || v === '' ? defaultValue(f) : Store.prepareValue(f, this.checkValue(entity, f, v));
      if (f.required && (use === null || use === undefined || use === '')) throw new Error(`${f.name} is required`);
      vals.push(use); sets.push(`${q(k)}=${ph(vals.length)}`);
    }
    if (!sets.length) return;
    // The guard: every update meets rules here too, against the row as it
    // would be stored (existing row + these values) — item 20.
    const problems = this.checkRules(entity, values, this.raw(entity, id));
    if (problems.length) throw new Error(problems[0]);
    this.drv.run(`UPDATE ${q(entity.toLowerCase())} SET ${sets.join(',')} WHERE id=${ph(vals.length + 1)}`, [...vals, Number(id)]);
  }

  remove(entity, id) {
    const { quote: q, ph } = this.drv.dialect;
    this.drv.run(`DELETE FROM ${q(entity.toLowerCase())} WHERE id=${ph(1)}`, [Number(id)]);
  }

  raw(entity, id) {
    if (id === undefined || id === null || id === '') return null;
    const { quote: q, ph } = this.drv.dialect;
    return this.drv.get(`SELECT * FROM ${q(entity.toLowerCase())} WHERE id=${ph(1)}`, [Number(id)]);
  }

  get(entity, id) { return this.hydrate(entity, this.raw(entity, id)); }

  exists(entity, field, value, excludeId = null) {
    const f = this.field(entity, field);
    const v = coerce(f, value);
    // Two logins that differ only in case are one login.
    const { quote: q, ph, lowerEq } = this.drv.dialect;
    const col = q(field);
    const sql = `SELECT id FROM ${q(entity.toLowerCase())} WHERE ${f?.type.exprKind === 'text' && typeof v === 'string' ? lowerEq(col, ph(1)) : `${col}=${ph(1)}`} AND id!=${ph(2)}`;
    return Boolean(this.drv.get(sql, [v, Number(excludeId ?? 0)]));
  }

  // Compound uniqueness: does another row already have this exact combination?
  // `stored` holds already-storage-form values (interp.mjs's "probe"), never raw
  // submitted text — unlike exists() above, this never re-coerces them.
  existsAll(entity, names, stored, excludeId = null) {
    const { quote: q, ph } = this.drv.dialect;
    const conds = names.map((n, i) => `${q(n)}=${ph(i + 1)}`).join(' AND ');
    const vals = names.map((n) => stored[n]);
    const sql = `SELECT id FROM ${q(entity.toLowerCase())} WHERE ${conds} AND id!=${ph(names.length + 1)}`;
    return Boolean(this.drv.get(sql, [...vals, Number(excludeId ?? 0)]));
  }

  // A count never needs a row hydrated — only when a where-clause targets a
  // derived field (query.mjs's "later", in-memory-only comparisons) is there
  // no SQL shortcut, and hydrating every matching row to filter it is the
  // only correct way to know how many pass.
  count(entity, where = {}) {
    const { clauses: cls, vals, later } = this.clauses(entity, where);
    if (later.length) return this.list(entity, { where }).length;
    const row = this.drv.get(`SELECT COUNT(*) AS n FROM ${this.drv.dialect.quote(entity.toLowerCase())}${cls.length ? ' WHERE ' + cls.join(' AND ') : ''}`, vals);
    return Number(row.n);
  }

  // `fn` gets the transaction-bound view of the store and must use it for everything it reads and writes
  // (docs/POSTGRES.md section 3). `within(tx)` is where S5 binds the driver's transaction handle to the store.
  // With the synchronous SQLite driver the view is the store itself, so nothing changes.
  // A `fn` that returns a promise is awaited by the driver before it commits.
  transaction(fn) {
    return this.drv.transaction((tx) => fn(this.within(tx)));
  }

  within(_tx) { return this; }

  // --- derived fields ----------------------------------------------------------
  // Pages, `get`, labels, CSV and dashboards evaluate over a snapshot loaded before evaluation
  // (runtime/store/hydrate.mjs, snapshot.mjs), and so do rules and step values (Store#evalCtx). What
  // follows is the lazy context: render/perms/field hooks (S3c) and the test-only `lazyEval` path.
  // The evaluation context of a row — runtime/store/ctx.mjs.
  /** @param {string} entity @param {any} row @param {string[]} [stack] @param {{ allowSecret?: boolean, cache?: any, clock?: Date }} [opts] */
  ctx(entity, row, stack = [], { allowSecret = false, cache = null, clock = undefined } = {}) {
    return new RowCtx(this, entity, row, stack, allowSecret, cache, clock);
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

  // One clock per evaluation, however many derived fields it reaches: read here once
  // (or the page's, cache.clock) and handed down, so `today`/`now` agree with each other and
  // with the value a compiled aggregate (runtime/store/aggsql.mjs) binds.
  derived(entity, row, f, stack = [], cache = null, clock = cache?.clock ?? new Date()) {
    const key = `${entity}.${f.name}`;
    checkCycle(stack, key);
    return fromExpr(f, evaluate(f.derive, this.ctx(entity, row, [...stack, key], { cache, clock }), this.registry.functions));
  }

  hydrate(entity, row) {
    return row ? this.hydratePage(entity, [row])[0] : row;
  }
}

// Queries/aggregation (runtime/store/query.mjs), the outbox/session tables
// (runtime/store/state.mjs) and rule enforcement (runtime/store/rules.mjs)
// are plain functions run with `this` bound to the Store instance — split
// out only to keep this file under the size budget; they are as much "the
// store" as anything above.
Object.assign(Store.prototype, query, hydrate, lazy, state, rules, migrate);

