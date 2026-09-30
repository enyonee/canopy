// Hydration: the load phase of S3a. A derived field is never evaluated against the database.
// Before evaluate() runs, `loadSnapshot` fetches everything the expression tree can touch — the
// read-set runtime/store/plan.mjs computes from the graph — level by level: the rows a reference
// hop points at (one `WHERE id IN (…)` per hop per level), the SQL-compiled aggregates of every
// row (aggsql's batch), the child rows of the others (one `listRawIn` per level, then the child
// entity's own plan). The query count is bounded by the size of the plan, not by the number of
// rows. Then evaluate() runs over a Snapshot (runtime/store/snapshot.mjs) whose reads are Map
// lookups and whose miss throws.
//
// Attached to Store.prototype by store.mjs (`this` is the Store). The old lazy path (lazy.mjs)
// stays behind the test-only switch `store.lazyEval`. Rules and step values (S3b) load the same way,
// for their own plans: `evalCtx` below.
import { compileAgg, runAggOne, runAggBatch, aggKey } from './aggsql.mjs';
import { planFor, planExpr, planFallback } from './plan.mjs';
import { Snapshot, Labels, refKey } from './snapshot.mjs';

// The values of a compiled aggregate for `ids`: one grouped query, or — for a lone row (a detail
// page, a re-read after a step) — the parent-by-parent query the statement cache already holds.
// `undefined` when the integers left SQLite's range (aggsql's `guarded`).
function batchOf(store, compiled, ids, clock) {
  if (ids.length > 1) return runAggBatch(store, compiled, ids, clock);
  const one = runAggOne(store, compiled, ids[0], clock);
  return one === undefined ? undefined : new Map([[String(ids[0]), one]]);
}

// The aggregate an `agg` node of a plan stands for, over `rows` of the plan node's entity.
function loadAgg(store, snap, node, entry, rows) {
  if (entry.compiled) {
    const key = aggKey(entry.compiled);
    if (!snap.declined.has(key)) {
      const missing = rows.filter((r) => !snap.hasScalar(key, r.id)).map((r) => r.id);
      if (missing.length) {
        const batch = batchOf(store, entry.compiled, missing, snap.clock);
        if (batch === undefined) snap.declined.add(key); else snap.addScalars(key, batch);
      }
    }
    // Integers past what SQLite holds: this aggregate is answered by evaluate() over child rows.
    if (!snap.declined.has(key)) return;
    planFallback(store, node, entry);
  }
  if (entry.via === null) {
    if (!snap.all.has(entry.child)) snap.all.set(entry.child, store.listRaw(entry.child));
    loadNode(store, snap, entry.sub, snap.all.get(entry.child));
    return;
  }
  const key = `${entry.child}|${entry.via}`;
  const missing = rows.filter((r) => !snap.hasGroup(key, r.id)).map((r) => r.id);
  if (missing.length) snap.addGroups(key, missing, store.listRawIn(entry.child, entry.via, missing));
  loadNode(store, snap, entry.sub, rows.flatMap((r) => snap.group(key, r.id)));
}

// Everything plan node `node` needs for `rows` (raw rows of its entity, already in the snapshot).
function loadNode(store, snap, node, rows) {
  if (!rows.length) return;
  for (const [field, sub] of node.hops) {
    const target = store.field(node.entity, field).target;
    const keys = [...new Set(rows.map((r) => refKey(r[field])).filter((k) => k !== null))];
    snap.putRows(target, store.listRawByIds(target, keys.filter((k) => !snap.hasRow(target, k))), keys);
    loadNode(store, snap, sub, keys.map((k) => snap.row(target, k)).filter(Boolean));
  }
  for (const entry of node.aggs.values()) loadAgg(store, snap, node, entry, rows);
}

// A snapshot able to evaluate the derived fields `fields` (all of them when null) of `rows`
// of `entity`; `clock` is the evaluation's one clock.
export function loadSnapshot(entity, rows, fields = null, clock = new Date()) {
  const snap = new Snapshot(this, clock);
  snap.putRows(entity, rows, rows.map((r) => String(r.id)));
  loadNode(this, snap, planFor(this, entity, fields), rows);
  return snap;
}

// The evaluation context of `row` (of `entity`) for expressions `asts` — a rule's check, a step's
// value (S3b). The expressions are planned and everything they read is loaded NOW, in the caller's
// transaction; evaluating over the context then performs no driver call. `key` names the
// expressions for the plan cache. `row` need not be stored (a rule's probe has id 0 and values
// that are not saved yet), so it is not put in the snapshot: a hop back to its entity loads the
// stored row, as a lazy read of it always did. `allowSecret` is a rule's (ctx.mjs).
// On the test-only lazy switch this is the old RowCtx, which queries while it evaluates.
export function evalCtx(entity, row, key, asts, allowSecret = false) {
  if (this.lazyEval) return this.ctx(entity, row, [], { allowSecret });
  const snap = new Snapshot(this, new Date());
  loadNode(this, snap, planExpr(this, entity, key, asts), row ? [row] : []);
  return snap.ctx(entity, row, [], allowSecret);
}

// The compiled form of an aggregate node read in `entity` — or null. A method so a test can
// switch the SQL compiler off for both paths (the JS reference of tests/aggfuzz.test.mjs).
export function compileAggIn(entity, node) { return compileAgg(this, entity, node); }

// The derived field `f` of one raw row (labelOf: a label never needs the row's other fields).
export function deriveOne(entity, row, f) {
  if (this.lazyEval) return this.derived(entity, row, f);
  return this.loadSnapshot(entity, [row], [f.name]).derived(entity, row, f);
}

// The labels of the rows `pairs` ([entity, id]) point at — what a page of reference cells shows — in ONE
// query per target entity (plus the batched snapshot of a derived label field), whatever the number of
// cells. Same text `labelOf` gives: '' for a row that is gone, `#id` for a blank label. The render phase
// reads them from the returned `Labels`, it never asks the store (S3c).
export function labelsFor(pairs) {
  const want = new Map();
  for (const [target, id] of pairs) {
    const key = refKey(id);
    if (key === null) continue;
    if (!want.has(target)) want.set(target, new Set());
    want.get(target).add(key);
  }
  const labels = new Labels();
  for (const [target, keys] of want) {
    const rows = this.listRawByIds(target, [...keys]);
    const lf = this.labelField(target), f = lf && this.field(target, lf);
    const snap = f?.derive && rows.length ? this.loadSnapshot(target, rows, [f.name]) : null;
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const key of keys) {
      const row = byId.get(key);
      const v = !row || !f ? null : snap ? snap.derived(target, row, f) : row[lf];
      labels.put(target, key, !row ? '' : v ? String(v) : `#${row.id}`);
    }
  }
  return labels;
}

// The rows a reference input offers, per target entity (`[{ id, label }]`, every row of it) — loaded
// by the form route before the form renders, read by an `input` hook as `ctx.options(target)`.
export function optionsFor(targets) {
  const out = new Map();
  for (const target of targets) if (!out.has(target)) out.set(target, this.list(target, {}).map((r) => ({ id: r.id, label: this.label(target, r) })));
  return out;
}

// How many rows to load and hydrate at once. A page of thousands of rows (a full CSV export,
// an in-memory dashboard aggregate) never holds every child it needed for the whole request,
// only one chunk's worth: the snapshot of a chunk is garbage the moment the chunk is hydrated.
const HYDRATE_CHUNK = 500;

function hydrateChunk(entity, rows, clock) {
  const derived = this.fields[entity].filter((f) => f.derive);
  if (!derived.length) return rows.map((row) => ({ ...row })); // nothing to evaluate: nothing to load
  if (this.lazyEval) return this.hydratePageLazy(entity, rows);
  const snap = this.loadSnapshot(entity, rows, null, clock);
  return rows.map((row) => {
    const out = { ...row };
    for (const f of derived) out[f.name] = snap.derived(entity, row, f);
    return out;
  });
}

// Hydrates a page of rows of one entity in a bounded number of queries, chunked (above).
export function hydratePage(entity, rows) {
  if (!rows.length) return [];
  const clock = new Date();
  const out = [];
  for (let i = 0; i < rows.length; i += HYDRATE_CHUNK) out.push(...hydrateChunk.call(this, entity, rows.slice(i, i + HYDRATE_CHUNK), clock));
  return out;
}
