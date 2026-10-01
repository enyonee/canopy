// What an asynchronous driver will do to every caller, before one exists: `npm run test:async` runs the whole suite
// (`node --import ./tests/asyncstore.mjs --test …`) with every EXTERNAL call of a Store method answering a Promise instead
// of a plain value. A call a store method makes on itself stays synchronous (the store's internals are S5's job, not a
// caller's), as do the pure lookups in the parsed graph (`field`, `fieldAt`, `label`, `labelField`, `childVia`, `within`)
// and the test-only lazy evaluation (`ctx`, `derived`, `clauses`, `compileAggIn`, `aggValue`, `buildAggCache`, the
// `store/lazy.mjs` hydrators, and the methods of `RowCtx`). A caller that forgot an `await` now reads `.map` off a Promise
// and fails here, the way it would fail on PostgreSQL — in the tests, in `runtime/` and in every plugin a test runs.
// `NODE_OPTIONS="--import ./tests/asyncstore.mjs"` does the same to the servers `verify/run.mjs` starts.
import { Store } from '../runtime/store.mjs';
import { RowCtx } from '../runtime/store/ctx.mjs';

const PURE = new Set(['field', 'fieldAt', 'label', 'labelField', 'childVia', 'within']);
const LAZY = new Set(['ctx', 'derived', 'clauses', 'compileAggIn', 'aggValue', 'buildAggCache', 'hydrateLazy', 'hydratePageLazy']);
let depth = 0; // > 0 while a store method (or a lazy context) runs: what it calls on the store is internal

const inside = (fn) => function internal(...a) { depth++; try { return fn.apply(this, a); } finally { depth--; } };

for (const name of Object.getOwnPropertyNames(Store.prototype)) {
  const orig = Store.prototype[name];
  if (name === 'constructor' || typeof orig !== 'function' || PURE.has(name)) continue;
  if (LAZY.has(name)) { Store.prototype[name] = inside(orig); continue; }
  Store.prototype[name] = function asyncMethod(...a) {
    if (depth > 0) return orig.apply(this, a);
    if (name === 'transaction') { // the callback is a caller too: what it calls is external again
      const fn = a[0];
      a = [(tx) => { const saved = depth; depth = 0; try { return fn(tx); } finally { depth = saved; } }];
    }
    depth++;
    try { return Promise.resolve(orig.apply(this, a)); } catch (e) { return Promise.reject(e); } finally { depth--; }
  };
}
for (const name of Object.getOwnPropertyNames(RowCtx.prototype)) {
  const orig = RowCtx.prototype[name];
  if (name !== 'constructor' && typeof orig === 'function') RowCtx.prototype[name] = inside(orig);
}
