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
// method always ran. The cache also carries the page's one clock, which evaluate()
// reads as `ctx.clock` (so `today`/`now` agree across the page and the compiled SQL).
import { toExpr } from '../spec.mjs';

export class RowCtx {
  constructor(store, entity, row, stack, allowSecret, cache) {
    this.store = store; this.entity = entity; this.row = row; this.stack = stack;
    this.allowSecret = allowSecret; this.cache = cache; this.clock = cache?.clock;
  }

  get(path) {
    const { store, entity, row, cache } = this;
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
    const v = toExpr(f, f.derive ? store.derived(entity, row, f, this.stack, cache) : row[head]);
    if (!rest.length) return v;
    if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
    const target = store.raw(f.target, v);
    return target ? store.ctx(f.target, target, this.stack, { cache }).get(rest) : null;
  }

  rows(child, via) {
    const { store, entity, row, cache } = this;
    const link = store.childVia(child, entity, via);
    const grouped = cache?.groups.get(`${child}|${link}`);
    const key = String(row.id);
    const raws = grouped?.has(key) ? grouped.get(key) : store.listRaw(child, { where: link ? { [link]: row.id } : {} });
    return raws.map((r) => store.ctx(child, r, this.stack, { cache }));
  }

  // Tried by runtime/expr.mjs's evaluate() before it calls rows() at all;
  // `undefined` means "not representable in SQL", which is exactly the
  // signal that tells evaluate() to fall back to rows() as before.
  agg(node, clock) { return this.store.aggValue(this.entity, this.row, node, this.cache, clock); }
}
