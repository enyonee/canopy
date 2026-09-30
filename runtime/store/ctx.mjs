// The evaluation context of one row (Store#ctx): field reads (money in major units),
// one hop through references, and the child rows an aggregate walks. A class, not an
// object of closures: a page evaluates one per derived field per row, and three
// closures plus their scope each time were most of what a heavy request allocated.
//
// `allowSecret` is for a rule check on the row's own submitted values (still plain
// text, not yet hashed, and never stored): it does not propagate through a hop or an
// aggregate, so a referenced row's real password hash stays unreadable.
// `cache` (runtime/store/hydrate.mjs's buildAggCache, via hydratePage) is a purely
// optional fast path for `rows()`/`agg()`: when it holds this exact (child, link)
// grouping (or, for a SQL-compilable aggregate, this exact scalar) already, that is
// used instead of a fresh query — for any row this ctx was ever built for,
// correlated or not, nested or not, so no branch here needs to tell those cases
// apart. Nothing is ever wrong without it; a cache miss is exactly the query this
// method always ran. `clock` is the evaluation's one clock (Store#derived), which evaluate()
// reads as `ctx.clock` and every derived field or hop below hands on unchanged — so `today`/`now`
// agree across the whole evaluation and with the value a compiled aggregate binds.
import { toExpr } from '../spec.mjs';

// The one wording of the cycle error, shared by the lazy path (Store#derived) and the snapshot
// path (Snapshot#derived): both reach a derived field with the chain of keys read so far.
export function checkCycle(stack, key) {
  if (stack.includes(key)) throw new Error(`derived field ${key} depends on itself (${[...stack, key].join(' → ')})`);
}

// The lazy context: every read that is not in `cache` asks the store now. Used by render/perms/field
// hooks (S3c moves them off it) and by the test-only `lazyEval` paths; rules and step values (S3b)
// run on a snapshot context (runtime/store/snapshot.mjs), which extends this class and overrides the
// four places that would query — derivedValue, hop, child, rows/agg.
export class RowCtx {
  constructor(store, entity, row, stack, allowSecret, cache, clock) {
    this.store = store; this.entity = entity; this.row = row; this.stack = stack;
    this.allowSecret = allowSecret; this.cache = cache; this.clock = clock ?? cache?.clock;
  }

  get(path) {
    const { store, entity, row } = this;
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
    if (f.type.secret && !this.allowSecret) throw new Error(`${entity}.${head} is secret; expressions cannot read it`);
    const v = toExpr(f, f.derive ? this.derivedValue(f) : row[head]);
    if (!rest.length) return v;
    if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
    const target = this.hop(f, v);
    return target ? this.child(f.target, target).get(rest) : null;
  }

  derivedValue(f) { return this.store.derived(this.entity, this.row, f, this.stack, this.cache, this.clock); }

  // The row a reference field points at, or a falsy value when it points at nothing.
  hop(f, v) { return this.store.raw(f.target, v); }

  // A context for another row that shares this evaluation's stack, cache and clock.
  child(entity, row) { return this.store.ctx(entity, row, this.stack, { cache: this.cache, clock: this.clock }); }

  rows(child, via) {
    const { store, entity, row, cache } = this;
    const link = store.childVia(child, entity, via);
    const grouped = cache?.groups.get(`${child}|${link}`);
    const key = String(row.id);
    const raws = grouped?.has(key) ? grouped.get(key) : store.listRaw(child, { where: link ? { [link]: row.id } : {} });
    return raws.map((r) => this.child(child, r));
  }

  // Tried by runtime/expr.mjs's evaluate() before it calls rows() at all;
  // `undefined` means "not representable in SQL", which is exactly the
  // signal that tells evaluate() to fall back to rows() as before.
  agg(node, clock) { return this.store.aggValue(this.entity, this.row, node, this.cache, clock); }
}
