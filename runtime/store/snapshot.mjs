// The data a derived field is evaluated over: loaded before evaluation (runtime/store/hydrate.mjs,
// from the plan of runtime/store/plan.mjs), read by Map lookup during it. `SnapCtx` is the
// evaluation context of one row — RowCtx's contract, answered from the snapshot. A read of
// anything that was not loaded THROWS `not loaded: <Entity.field>`: it is a bug in the plan, and
// it must never turn into a silent query (evaluation performs zero driver calls).
import { evaluate } from '../expr.mjs';
import { fromExpr } from '../spec.mjs';
import { RowCtx, checkCycle } from './ctx.mjs';
import { aggKey } from './aggsql.mjs';

const notLoaded = (what) => new Error(`not loaded: ${what}`);

/** The key a reference value is looked up by, or null when it points at no row (empty, or not a number). */
export function refKey(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : String(n);
}

export class Snapshot {
  constructor(store, clock) {
    this.store = store; this.clock = clock;
    this.rows = new Map();      // entity -> Map<id, raw row | null (asked for, not there)>
    this.groups = new Map();    // `child|via` -> Map<parent id, child rows, ORDER BY id DESC>
    this.all = new Map();       // child -> every row of it (an aggregate with no link back)
    this.scalars = new Map();   // aggKey -> Map<parent id, value> (SQL-compiled aggregates)
    this.declined = new Set();  // aggKeys whose batch declined: evaluate() walks their child rows
  }

  putRows(entity, rows, asked) {
    if (!this.rows.has(entity)) this.rows.set(entity, new Map());
    const map = this.rows.get(entity);
    for (const k of asked) if (!map.has(k)) map.set(k, null);
    for (const r of rows) map.set(String(r.id), r);
  }
  hasRow(entity, key) { return Boolean(this.rows.get(entity)?.has(key)); }
  row(entity, key) { return this.rows.get(entity)?.get(key) ?? null; }

  addGroups(key, parents, children) {
    if (!this.groups.has(key)) this.groups.set(key, new Map());
    const map = this.groups.get(key), via = key.slice(key.indexOf('|') + 1);
    for (const id of parents) map.set(String(id), []);
    // A ref column is stored as TEXT (fields.mjs's ref.sql): grouped by the string form of both sides.
    for (const r of children) map.get(String(r[via]))?.push(r);
  }
  hasGroup(key, id) { return Boolean(this.groups.get(key)?.has(String(id))); }
  group(key, id) { return this.groups.get(key).get(String(id)); }

  addScalars(key, batch) {
    if (!this.scalars.has(key)) this.scalars.set(key, new Map());
    for (const [id, v] of batch) this.scalars.get(key).set(id, v);
  }
  hasScalar(key, id) { return Boolean(this.scalars.get(key)?.has(String(id))); }

  ctx(entity, row, stack) { return new SnapCtx(this, entity, row, stack); }

  // The derived field `f` of `row`, evaluated over this snapshot.
  derived(entity, row, f, stack = []) {
    const key = `${entity}.${f.name}`;
    checkCycle(stack, key);
    return fromExpr(f, evaluate(f.derive, this.ctx(entity, row, [...stack, key]), this.store.registry.functions));
  }
}

class SnapCtx extends RowCtx {
  constructor(snap, entity, row, stack) {
    super(snap.store, entity, row, stack, false, null, snap.clock);
    this.snap = snap;
  }

  derivedValue(f) { return this.snap.derived(this.entity, this.row, f, this.stack); }

  hop(f, v) {
    const key = refKey(v);
    if (key === null) return null;
    if (!this.snap.hasRow(f.target, key)) throw notLoaded(`${this.entity}.${f.name}`);
    return this.snap.row(f.target, key);
  }

  child(entity, row) { return this.snap.ctx(entity, row, this.stack); }

  rows(child, via) {
    const { store, entity, row, snap } = this;
    const link = store.childVia(child, entity, via);
    const list = link === null ? snap.all.get(child) : snap.groups.get(`${child}|${link}`)?.get(String(row.id));
    if (!list) throw notLoaded(`${child}.${link ?? '*'}`);
    return list.map((r) => this.child(child, r));
  }

  agg(node) {
    const { store, entity, row, snap } = this;
    const compiled = store.compileAggIn(entity, node);
    if (!compiled) return undefined;
    const key = aggKey(compiled), scalars = snap.scalars.get(key);
    if (scalars?.has(String(row.id))) return scalars.get(String(row.id));
    if (snap.declined.has(key)) return undefined;
    throw notLoaded(`${entity}.${node.fn}(${node.entity})`);
  }
}
