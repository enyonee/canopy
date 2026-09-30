// The read-set of derived fields, computed from the graph alone — no driver call, no row.
// runtime/store/hydrate.mjs loads what a plan names before evaluate() runs; a snapshot
// (runtime/store/snapshot.mjs) then answers every read from that data or throws.
//
// A plan is a tree of nodes, one per "rows of this entity reached this way":
//   node.hops  ref field -> node of the target entity  (one `WHERE id IN (…)` per hop per level)
//   node.aggs  agg AST node -> { child, via, compiled, sub }
//              `compiled`: answered by aggsql's batch, nothing else to load;
//              otherwise `sub` is the node of the child rows (fetched by `via`, or all of them
//              when the child has no link back) with the aggregate body planned inside it.
// Walking mirrors what evaluation reads, over-approximately (both branches of `if`, both sides
// of `and`): derived fields are followed through their expressions (a derived field is
// expanded once per node, unless a cycle cut it), a path through references adds a hop per
// segment, `row.x` in a body reads the enclosing node. An aggregate inside another aggregate's
// body is never compiled: evaluate() gives a body's rows no `agg` hook, so it walks rows.
//
// The derivation stack works as it does in evaluation (Store#derived): a key already on it is
// a cycle, evaluation throws there before reading anything, so the walk stops there too.

class Node {
  constructor(entity) { this.entity = entity; this.hops = new Map(); this.aggs = new Map(); this.done = new Set(); }
}

// A failing lookup (an ambiguous or wrong `via`, say) is not the planner's to report: evaluation
// raises the same error, with the same text, if this branch is ever taken. `null` says "failed".
function attempt(fn) {
  try { return { value: fn() }; } catch { return null; } // allow-swallow: the evaluation of this node raises the same error
}

function walkPath(cx, scopes, path, stack) {
  let up = scopes.length - 1, p = path;
  while (p[0] === 'row' && p.length > 1 && up > 0) { up--; p = p.slice(1); }
  readPath(cx, scopes[up], p, stack);
}

function readPath(cx, node, path, stack) {
  const [head, ...rest] = path;
  const f = cx.store.field(node.entity, head);
  if (!f) return;
  if (f.derive) expand(cx, node, f, stack);
  if (!rest.length || f.kind !== 'ref') return;
  if (!node.hops.has(head)) node.hops.set(head, new Node(f.target));
  readPath(cx, node.hops.get(head), rest, stack);
}

// Runs `walkFn`; true when no cycle was cut inside it (so its result holds for any stack).
function clean(cx, walkFn) {
  const before = cx.cuts;
  walkFn();
  return cx.cuts === before;
}

function expand(cx, node, f, stack) {
  const key = `${node.entity}.${f.name}`;
  if (stack.includes(key)) { cx.cuts++; return; }
  if (node.done.has(f.name)) return;
  if (clean(cx, () => walk(cx, f.derive, [node], [...stack, key], false))) node.done.add(f.name);
}

function walk(cx, n, scopes, stack, inBody) {
  switch (n.t) {
    case 'path': if (n.p.length > 1 || (n.p[0] !== 'today' && n.p[0] !== 'now')) walkPath(cx, scopes, n.p, stack); return;
    case 'un': walk(cx, n.a, scopes, stack, inBody); return;
    case 'bin': walk(cx, n.a, scopes, stack, inBody); walk(cx, n.b, scopes, stack, inBody); return;
    case 'call': for (const a of n.args) walk(cx, a, scopes, stack, inBody); return;
    case 'agg': planAgg(cx, n, scopes, stack, inBody); return;
    default: // a literal
  }
}

function planAgg(cx, n, scopes, stack, inBody) {
  const node = scopes[scopes.length - 1];
  if (!node.aggs.has(n)) {
    const via = attempt(() => cx.store.childVia(n.entity, node.entity, n.via));
    const compiled = via && (inBody ? { value: null } : attempt(() => cx.store.compileAggIn(node.entity, n)));
    if (!compiled) return;
    node.aggs.set(n, { node: n, child: n.entity, via: via.value, compiled: compiled.value, sub: null, clean: false });
  }
  const entry = node.aggs.get(n);
  if (!entry.compiled) planBody(cx, entry, scopes, stack);
}

function planBody(cx, entry, scopes, stack) {
  if (entry.clean) return;
  entry.sub ??= new Node(entry.child);
  entry.clean = clean(cx, () => { if (entry.node.body) walk(cx, entry.node.body, [...scopes, entry.sub], stack, true); });
}

/** The plan of the derived fields `fields` (all of them when null) of rows of `entity`; cached in `store.plans`. */
export function planFor(store, entity, fields = null) {
  const cache = store.plans, key = `${entity}|${fields ? fields.join(',') : '*'}`;
  if (cache.has(key)) return cache.get(key);
  const cx = { store, cuts: 0 };
  const root = new Node(entity);
  for (const f of store.fields[entity]) if (f.derive && (!fields || fields.includes(f.name))) expand(cx, root, f, []);
  cache.set(key, root);
  return root;
}

/**
 * The read-set of expressions `asts` evaluated over one row of `entity` (a rule's check, a step's
 * `= expr` or `@path`): the plan of a derived field's expression, taken from the expression itself.
 * Cached in `store.plans`: by `key` (what the expressions are made of), then by entity.
 */
export function planExpr(store, entity, key, asts) {
  let byEntity = store.plans.get(key);
  if (!byEntity) store.plans.set(key, byEntity = new Map());
  if (byEntity.has(entity)) return byEntity.get(entity);
  const cx = { store, cuts: 0 }, root = new Node(entity);
  for (const ast of asts) walk(cx, ast, [root], [], false);
  byEntity.set(entity, root);
  return root;
}

/** A compiled aggregate that declined at run time (integers past SQLite's range) is evaluated over child rows: plan them. */
export function planFallback(store, node, entry) {
  if (entry.sub) return;
  planBody({ store, cuts: 0 }, entry, [node], []);
}
