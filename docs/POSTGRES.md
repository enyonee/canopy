# R10 design: async Driver seam and PostgreSQL (README roadmap step 1)

**Status: design accepted (option C4); S1 done in 0.2.x.** Status per stage:

| stage | what | status |
|---|---|---|
| S1 | sync `Driver` seam (`runtime/driver/sqlite.mjs`, `runtime/driver.mjs`) | **done** (0.2.x) |
| S2 | portable SQL and dialect hooks | not started |
| S3a-c | snapshot evaluation on prefetched data | not started |
| S4a-d | await-first conversion | not started |
| S5 | flip to an async driver | not started |
| S6 | `runtime/driver/postgres.mjs` | not started |
| S7 | benchmark before/after, load test | not started |

Sections below are the design as accepted; line numbers in section 1 cite v0.1.2 and
predate S1.

Read-only analysis of canopy v0.1.2 (main). Nothing was run; sizes are estimates from
line counts and call-site greps. Cites are `file:line` on current main.

## 1. Inventory

### 1.1 Everything that reaches the database, by layer
Raw SQL text sites (only in the "store" layer; `node:sqlite` is confined to `store.mjs`, arch.test.mjs:235):

| module | SQL sites | what |
|---|---|---|
| `store.mjs` | 18 | ctor `DatabaseSync` :19; `prepare` LRU cache :42-49; `migrate` :51-88 (sqlite_master :56, CREATE :59, PRAGMA :64, ALTER :67, backfill UPDATE :71, `_outbox` DDL :84, `_session` DDL :87); `insert` :143-146; `update` :166; `remove` :170; `raw` :175; `exists` :185-187; `existsAll` :196-197; `count` :208; `transaction` :212-216 |
| `store/query.mjs` | 6 | `listRaw` :80, `listRawPage` :88, `countRaw` :94, `listRawIn` :125 (bypasses the cache), `aggregate` :194-206; plus WHERE builders `clauses` :14-38, `buildWhere` :62-69, `orderBy` :73-76 |
| `store/aggsql.mjs` | 2 (+ builders) | `runAggOne` :144-147, `runAggBatch` :155-166; SQL generators `compileValue/Bool/Cmp` :34-104 |
| `store/state.mjs` | 6 | `enqueue` :7, `outbox` :10-14, `outboxUpdate` :17-21, `sessionSet` :25, `sessionUser` :30, `sessionEnd` :33 |
| `store/migrate.mjs` | 3 | `migrateIndexes` :52 (sqlite_master), :59 CREATE INDEX, :65 DROP INDEX |
| `store/hydrate.mjs`, `store/rules.mjs` | 0 direct | reach SQL through `listRawIn`, `runAggBatch`, `exists*` |

Store methods called from outside the store layer (`store.<m>(`; grep count of DB-reaching calls):
`blocks.mjs` 20, `routes/views.mjs` 15, `routes/entity.mjs` 14, `interp.mjs` 10, `auth.mjs` 7,
`boot.mjs` 6, `routes/system.mjs` 6, `routes/context.mjs` 6, `render/dashboard.mjs` 6,
`routes/rows.mjs` 5, `routes/session.mjs` 4, `fields.mjs` 3, `render/pages.mjs` 2, `render.mjs` 2,
`outbox.mjs` 2, `render/list.mjs` 1, `render/detail.mjs` 1, `server.mjs` 1 (`store.migrations`, no SQL).
Total outside the store layer: about 110 call sites in 18 modules; inside: ~60.

Write paths (all end in `Store#insert/update/remove`, guarded by `checkRules` store.mjs:141,164):
routes/entity.mjs:65-68, 97-100, 118-121 (create/edit/delete), routes/rows.mjs:52-55 (transition), :88-91 (add child),
:21 (action), routes/session.mjs:49 (register), routes/system.mjs:62 (global action), routes/schedule.mjs:16,
server.mjs:58 (timer), boot.mjs:13,54-61 (identity, seed). All but boot go through `interp.attempt` -> `withEffects`
(interp.mjs:87-95) = `store.transaction(fn)` then `flush(outbox)` outside the transaction.

### 1.2 Where expression evaluation reaches the store lazily
`evaluate()` has 3 call sites in the runtime: `store.mjs:281` (derived field), `store/rules.mjs:59` (rule `check`),
`interp.mjs:62` (`= expr` in a step). It pulls data through `ctx` callbacks (expr.mjs:205 `ctx.get`, :238 `ctx.agg`,
:239 `ctx.rows`), implemented by `Store#ctx` (store.mjs:231-265):

1. **Ref hop**: `ctx.get(['customer','discount'])` -> `store.raw(f.target, v)` store.mjs:250 -> nested `store.ctx(...)`. One query per hop per row, never batched or cached (N+1 on every list page, today).
2. **Derived field read**: `ctx.get` -> `store.derived` :247 -> `evaluate` :281 (recursion, cycle guard through `stack` :280); `hydrate` :284-288 evaluates every derived field per row; `labelOf` :144 derives just the label field; `interp.mjs:111,126` re-hydrates the row after every step.
3. **Aggregate**: `ctx.agg` -> `aggValue` (hydrate.mjs:77-83) -> SQL-compiled scalar (`runAggOne` :144) or `ctx.rows` -> `listRaw` store.mjs:257 (child rows) -> per-child `store.ctx` -> recurse. Page batching (`buildAggCache` hydrate.mjs:38-68, chunk 500 :94-112) prefetches only aggregates written directly on derived fields of the page entity and their child-entity aggregates; it does not prefetch hops or derived fields read from an aggregate body.
4. **Rules**: `checkRules` rules.mjs:180-208: `exists` :189 and `existsAll` :197 (SQL) and `evaluate` :204 on the probe row (may hop/aggregate; probe.id is 0 for a create). Reached from `Store#insert/update` and `interp.validateValues` :159.
5. **Step values**: `interp.mjs` `refValue` :29-48 (`@me.x` -> `store.raw` :35 + `ctx().get`; `@row.a.b` :45), `exprCtx` :50-57, `interpolate` :71-78 (inside `String#replace` callback), `afterPath` :83.
6. `exists` is not in the expression grammar; it is the unique rule guard (item 5 above/4). `store.count` :204-210 falls back to a full `list()` when a where names a derived field.

Non-expression sync consumers that would break under an async store (the "colored function" hot spots):
- Field-kind hooks receive the store: `ref.validate` -> `store.raw` fields.mjs:150 (called from `Store#checkValue` store.mjs:122 on every ref write); `ref.format` -> `store.labelOf` :151 (every ref cell, per row); `ref.input` -> `store.list(target)` :152. No plugin field kind touches the store (grep), so the contract can change freely.
- Permissions are sync predicates that hit the DB: `matchesPath` auth.mjs:81 (`store.raw` for a one-hop `own`), `idsForPath` :89-95 (`store.list`), used by `perms.can/ownOk/ownWhere` inside per-row render loops (`rowButtons`/`transitionsFor` render.mjs:~130-160) and by 10+ route sites.
- Render cells: `plain()` render.mjs:172, `render/dashboard.mjs:17,123`, `routes/views.mjs:31,42` (`labelOf`), `render/list.mjs:31`, `render/detail.mjs:31`.
- `createContext` `store.get(graph.roles.entity, sess.read(...))` routes/context.mjs:86 (every request) and `sessions()` auth.mjs:47-56.
- Callbacks passed to array/string sync iterators: `.map/.filter` in render and auth, `String#replace` in interpolate.

### 1.3 Plugin/block API that exposes the store to app code
`block.run(ctx)` receives the whole `store` plus `resolve`, `text`, `run`, `fireCreated` (interp.mjs:114-118); `types.d.ts:130` types it `any`. Other registry tables: functions (`run(args)` pure, no store), transports (`deliver` already async, no store), widgets (client only), field kinds (hooks above; store only via `validate/format/input`).
Store calls made by plugin code (grep, all `store.X(` in `apps/*/plugins` and `plugins/`):

| call | call sites | plugin files |
|---|---|---|
| `store.update` | 37 | baseball 4, chess 7, diagrams 1, game2048 3, poker 16, recycling 1, shop 1, strategy 3, tictactoe 1 (9 files) |
| `store.get` | 35 | baseball 6, chess 7, diagrams 1, game2048 2, poker 10, recycling 4, shop 1, strategy 2, tictactoe 1, vocab 1 (10 files) |
| `store.insert` | 13 | baseball 1, chess 3, poker 4, recycling 1, strategy 3, vocab 1 (6 files) |
| `store.list` | 7 | baseball, chess 3, diagrams, poker, recycling (5 files) |
| `store.remove` | 1 | chess |
| `store.enqueue` | 2 | shared `plugins/payment.mjs`, `plugins/messaging.mjs` |
| `raw/count/exists/aggregate/transaction` | 0 | none |

16 plugin modules exist, 14 with a `run`; 12 files touch the store, 4 are pure (calc/arith, attendance-calc, studentportal/matching, coachmatch). 10 of 104 apps ship a store-touching plugin. Sync helper functions that must become async with them: poker 9 (`seatsOf, dealNewHand, finishHand, closeStreet, applyAction, takeTurn, botAction, resolveBots, bump`), chess 1 (`bumpStats`), baseball 1 (`lineupOf`). Built-in `blocks.mjs` uses ~20 store calls (db.create/update/set/delete/toggle/createRow/adjust/ensure/each, random.pick, check.matchRef, http/connector/mail.send).

## 2. The core problem

`evaluate(ast, ctx)` (expr.mjs:194) is a sync tree walk whose `ctx.get/rows/agg` closures synchronously call SQLite (`Store#ctx`, store.mjs:231). The read-set of an expression is discovered *during* evaluation. With an async driver a sync function cannot wait, so any of: (a) evaluation becomes async, (b) the read-set is loaded before evaluation, (c) the driver stays sync-callable.

Two facts drive the choice:
1. expr.mjs's header promises "no way to reach past the row it is evaluated on - every computation is a pure leaf", but that is only true structurally, not behaviourally: `ctx.rows` executes SQL and (with one connection) is deterministic only because nothing interleaves. The invariant in AGENTS.md is honoured today by sync execution, not by construction.
2. The read-set is statically derivable for expressions (closed algebra, finite graph) but NOT for blocks: a plugin decides at run time what it reads (`store.list('Move', { where: { game: id } })`). So expressions can be made pure; blocks cannot, and must be allowed to be async effect nodes. That is coherent with the invariant: blocks are effect nodes.

### Option A: async all the way down, `evaluate` included
- Change: `evaluate` -> `async`, `ev` awaits every child (expr.mjs ~+30 lines; 5 mutations re-pointed); `Store#ctx/derived/hydrate/labelOf/checkRules/count/list...` async; `interpolate` (String#replace callback) rewritten; perms `can` async -> every `.filter/.map` in render/auth; all 8 `render/*` files, 8 `routes/*`, interp, blocks, boot, server; field hooks `validate/format/input` async (public plugin contract change).
- Size: ~2,000-2,800 changed lines in ~45 runtime files + ~450 test lines (~370 sync store/evaluate call sites in 17 test files). Big-bang: colored functions force a single atomic PR, or a long-lived branch.
- Pros: conceptually simplest; no new subsystem; laziness stays (no over-fetching).
- Cons: (i) a "pure leaf" becomes an effectful async function; nothing distinguishes it from a block; the invariant is now only a convention. (ii) N+1 stays, but every hop/aggregate miss is a network RTT on pg (README: "a round trip costs a constant, not one per row" only holds because of the page cache, which A leaves incomplete for hops). (iii) an expression is no longer atomic: with a pool, `count(Item)` and `sum(Item: x)` in one derived field can read different commits (needs a snapshot tx per read request). (iv) sequential awaits per node/row per derived field; promise allocation per AST node (unmeasured, order of a few x on pure arithmetic; measure with bench/run.mjs). (v) 100% line coverage and mutation gate need async twins everywhere.

### Option B: pure sync `evaluate` over an async-prefetched snapshot
- New pure module `store/plan.mjs`: given (graph, entity, AST) compute the read-set: derived closure (through `derive` ASTs, cycle detection statically, same error text as store.mjs:280), ref hops (per (entity, ref field) -> `SELECT ... WHERE id IN`), aggregates (compilable ones -> `runAggBatch`, others -> `listRawIn` + recursion into the child entity's own plan, level by level). Query count is bounded by plan size, independent of row count (extends hydrate.mjs's page cache and aggsql.mjs's batching).
- New `store/snapshot.mjs`: a `ctx` whose `get/rows/agg` are Map lookups; a miss throws `not loaded: <entity.field>` (a bug, never a silent query). `evaluate` and expr.mjs stay byte-identical (only the ctx changes; expr.mjs keeps `ctx.rows`/`ctx.agg` signatures).
- Load points: `hydratePage(rows)` (already exists), `checkRules` (plan of the rule over the probe), `interp.resolve` (`await load(exprs, row)` then sync evaluate; steps' expressions are statically enumerable from the step JSON, but writes between steps mean loading per resolve, inside blocks).
- Size: new plan.mjs ~250 lines + snapshot.mjs ~120; hydrate.mjs rewritten (~110 -> ~150); store.mjs ctx block -80/+40; rules +30; interp +60; tests +300 (plan unit tests, "evaluate performs zero driver calls" gate, N+1 fixes). ~1,000-1,300 lines total. Can be done while the driver is still sync (this is what makes it stageable).
- Pros: makes the header of expr.mjs true; a testable purity gate (driver call counter must not move during `evaluate`); fixes existing hop N+1 (perf win independent of pg); expression atomicity for free (loaded in one read phase); render/perms can follow the same pattern (prefetch labels/own-parents, then pure formatting).
- Cons: over-fetch risk (short-circuit `and/or`/`if` branches are not taken but their reads are loaded: prefetch is conservative; bounded by static plan, mostly parent-level batch); complexity in the level-by-level fan-out for uncompilable aggregate bodies with hops; probe-row rules (id 0) need care; not sufficient alone: blocks/interp/routes still go async, so B is a component of the solution, not the whole.

### Option C: alternatives
- C1 sans-IO generators (`function*` store logic driven by a sync or async runner): one code path, sync SQLite stays sync. Rejected: `yield*` contagion through query/hydrate/rules doubles coverage cost (100% lines gate), and plugins still need a callable API, so the public surface is duplicated.
- C2 sync-over-worker bridge for pg (`worker_threads` + `Atomics.wait`): tiny diff, zero contract change, transactions trivially serial, keeps every layer sync. Delivers pg end-to-end quickly and lets CI run the 699 checks on pg before the refactor. Cons: blocks the event loop per query (throughput = 1/(queries x RTT) per instance, no real concurrency, defeats the "many concurrent writers" motivation), still needs the whole dialect work. Useful only as a spike/validation tool, not as the product.
- C3 unit-of-work: sync core over an in-memory overlay, write-set flushed async at commit. Rejected: blocks read what they choose (see above), read-your-writes overlay = re-implementing the DB.
- **C4 (recommended): B for compute + async effect layer + explicit transaction views**, migrated "await-first" (section 5): `await` on a non-promise is a no-op, so every caller can be converted to `await store.x()` while the store is still sync; the flip to a Promise-returning driver is then a small final PR.

### Invariant ranking ("every effect is a node, every computation a pure leaf")
B/C4 > C2 > A. B/C4 turns "pure leaf" into an executable gate (evaluate, format, validate, perms predicates get already-loaded data; only blocks/routes/loader await). C2 preserves the shape but hides IO behind sync calls. A erases the distinction.

## 3. Transactions

Today's safety is accidental: `Store#transaction` (store.mjs:212) runs `fn` synchronously, so no other request can run between BEGIN and COMMIT; `flush` (outbox.mjs:29-32) runs after commit and is async, so the only interleaving today is delivery.
Once `fn` awaits, on one `DatabaseSync` connection: request B's `BEGIN` fails ("cannot start a transaction within a transaction"), or B's plain reads see A's uncommitted rows (dirty reads), or B's COMMIT/ROLLBACK ends A's transaction. The async wrapper must therefore serialize.

Design (both drivers, same interface):
- `Driver.transaction(fn, { write = true })` -> `Promise`. `fn` receives a **transaction-bound Store view** (`store.within(tx)` = `Object.create(store)` with `drv = tx`). `interp.attempt(fn)` passes it as `ctx.store` to blocks (interp.mjs:115) and to route closures (`attempt((tx) => tx.insert(...))` at entity.mjs:65,97,118, rows.mjs:52,88, session.mjs:49). Explicit view instead of AsyncLocalStorage: effects stay visible in the code and plugins are unchanged (they already take `store` from ctx).
- **SQLite**: one connection, one FIFO async mutex in the driver. A transaction holds it from BEGIN to COMMIT/ROLLBACK including awaits; non-transactional `all/get/run` take it per statement (so reads never see uncommitted data). Throughput equals today's (serial). Guard against self-deadlock (root store called from inside a tx closure): in test mode a mutex wait > N s throws "store call outside its transaction view". Possible later: WAL + read-only second connection for non-tx reads (file DBs only; `:memory:` tests cannot share).
- **pg**: `pool.connect()` -> client per transaction, `BEGIN`, release in `finally`; non-tx statements use `pool.query`. Default READ COMMITTED loses updates in read-modify-write blocks (`db.adjust` blocks.mjs:309-317, poker/chess/strategy plugins: `get` then `update`), which the serial SQLite model hid. v1: `pg_advisory_xact_lock(hash(app schema))` at the start of every write transaction (same semantics as SQLite, works across instances); later SERIALIZABLE + retry on 40001 (safe because steps are deterministic apart from `random.pick`/clock and effects are outbox rows rolled back with the tx), or `SELECT ... FOR UPDATE` in `get` inside write txs.
- **Read consistency for a request**: one read phase per page inside `BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ` on pg (SQLite: covered by the mutex); B's load phase is the natural place.
- **Outbox**: enqueue stays inside the tx; `flush` after commit as today. `flush` reads `queued` then delivers then updates, so two concurrent flushes can double-deliver (latent today because `deliver` awaits; worse with several instances). Needs an atomic claim (`UPDATE "_outbox" SET status='sending' WHERE id=? AND status='queued'` checking the changed-row count, or `FOR UPDATE SKIP LOCKED` on pg) in state.mjs; add a mutation for it.
- **Boot**: `serve()` (server.mjs:66-112) is sync: `new Store` migrates in its constructor, `bootstrapIdentity/Seed` sync. Needs `Store.open()` (async factory; `new Store(graph, file)` stays as the sync-SQLite convenience for the ~90 test constructions) and `serve()` returning `{ server, ready }` with `listen` after `ready`; seed failure keeps the `invalidGraphServer` path.

## 4. Plugin contract change

New contract (documented in FORMAT.md "Plugins" and BlockType in types.d.ts:117): inside `run(ctx)`, `ctx.store.*`, `ctx.resolve(...)`, `ctx.text(...)` may return promises and must be awaited; `run` may be `async`. A plugin declares nothing new for functions/transports/widgets (pure or already async). Field-kind hooks: `validate(v, f)` drops the `store` argument (ref existence checked by the kernel), `format(v, f, ctx)` gets `ctx.label(target, id)` from a prefetched map, `input(f, v, ctx)` gets `ctx.options(target)` prefetched by the form route; no plugin field kind uses the store today, so zero plugin impact there.

Per plugin (mechanical: add `await`, mark helper functions `async`):
poker (4 blocks, 9 helpers, ~30 call sites; biggest), chess (5 blocks + `bumpStats`, ~19), baseball (1 block + `lineupOf`, ~12), strategy (3 blocks, 8), recycling (1, 7), game2048 (3, 5), vocab (1, 2), diagrams (1, 3 incl. a loop), tictactoe (1, 2), shop/loyalty (1, 2), shared payment/messaging (`store.enqueue`, 1 each). About 95 call sites, ~130 changed lines in 12 files. calc, attendance, studentportal, coachmatch: none.

Compatibility shim: yes, for SQLite only, and it is free by construction: a sync driver keeps returning plain values, and `await value` is a no-op, so unchanged legacy plugins keep working on SQLite while new/converted ones work on both. Not possible on pg (a legacy plugin sees a Promise where it expects a row). So: plugin modules may export `async: true` (or `api: 2`); `check/plugins.mjs` fails closed when the configured driver is async and a loaded plugin lacks the marker (a checker error, not a runtime crash); the acceptance apps are converted in S4c so both drivers run the same 699 checks. A sync bridge (C2) could serve legacy plugins on pg but blocks the loop, so it is not part of the plan.

## 5. Staged plan (each stage = one PR; `npm run gate` and 699/699 green)

`mutate.mjs` matches exact source text: 87 of its 143 mutations sit in files below (store.mjs 10, query 16, rules 4, hydrate 5, aggsql 6, migrate 2, interp 12, blocks 8, expr 5, entity 8, rows 3, auth 7, outbox 1); moved text must be re-pointed, never dropped. Run mutate alone (it edits runtime in place).

**S1 - Driver seam, still sync (smallest useful). DONE.** ~+230/-120 runtime, +90 tests, ~14 files.
- New `runtime/driver/sqlite.mjs` (layer 0 leaf, imports only `node:sqlite`; ~130 lines): `all(sql, p)`, `get(sql, p)`, `run(sql, p) -> { changes, lastId }`, `exec(sql)`, `transaction(fn)`, `close()`, the prepared-statement LRU moved from store.mjs:38-49, `dialect` object (name, `quote`, `insertId`), schema helpers `tables()`, `columns(t)`, `indexes(t, prefix)`, `addColumn/createTable/createIndex/dropIndex` so PRAGMA/sqlite_master/AUTOINCREMENT leave the store. New `runtime/driver.mjs` (`open(fileOrDriver)`) + `Driver` typedef in types.d.ts. Contract is written as "results may be awaited"; S1 code does not await.
- `store.mjs` :19,42-49,56-87,143-146,166-215 and `query.mjs` (6), `state.mjs` (6), `migrate.mjs` (3), `aggsql.mjs` (2) call `this.drv.*` only. `Store` takes an optional driver (4th ctor arg).
- arch.test.mjs: `node:sqlite` row moves from `store.mjs` to `driver/sqlite.mjs`; ALLOWED gets `runtime/store.mjs -> runtime/driver.mjs -> runtime/driver/sqlite.mjs`; new gate "SQL text and `.prepare(`/`.exec(`/`this.db` appear only in runtime/store*/ and runtime/driver/, and `runtime/store/**` never names `DatabaseSync`".
- Tests: 27 `store.db.*` sites (edges, store, store2, blocks, perf) use `store.drv.db` or `store.drv.columns/indexes`; perf.test.mjs:164 (monkeypatched `db.prepare` to count queries) switches to a driver query hook (`onQuery`), which S3 reuses. Mutations re-pointed: backfill (store.mjs:71), ROLLBACK (:167), DROP INDEX (migrate:65), exists/LOWER (:185), item-20 guards (:141,164); added: tx rollback in the driver, LRU eviction, `run().lastId`.
- Behaviour byte-identical; JSON of the benchmark routes unchanged.

**S2 - Portable SQL and dialect hooks (SQLite still the only executor).** ~+200/-60, ~9 files.
- New `runtime/driver/dialects.mjs` (layer 0, pure): `sqlite` and `postgres` dialect objects: `placeholders`, `quote`, `idType`, `intType (BIGINT)`, `insertReturning`, `lowerLike`, `bucket(col, unit)`, `nullsOrder`, `boolCond`. Store builders call the dialect (query.mjs:28,65,194; aggsql.mjs:86; state.mjs:25).
- Portable-by-construction rewrites in SQLite: `IFNULL`->`COALESCE`, quote every column in `_outbox`/`_session` DDL and DML, make aggsql booleans CASE-wrapped 0/1 instead of relying on SQLite's boolean integers, `ORDER BY ... , id` tie-break (see risks: must keep benchmark JSON identical, measure).
- New `tests/dialect.test.mjs`: golden SQL text per dialect (pg text generated without a server), plus the arch gate "runtime/store/** contains no SQLite-only keyword" (list in section 6).
- Mutations: LIKE/escape, month bucket, coalesce, tie-break, quoting.

**S3a - Snapshot evaluation (sync driver): plan + snapshot for derived fields.** ~+450/-200 runtime, +300 tests.
- New `store/plan.mjs` (pure, layer with query/aggsql), new `store/snapshot.mjs`; `hydrate.mjs` becomes the loader (level-batched: hops, aggregates, derived closure); `store.mjs` `ctx/derived/hydrate` (:231-289) read from the snapshot; `labelOf`, `count` use it.
- Gate: "no driver call while `evaluate` runs" (uses S1's `onQuery`), N+1 gates in perf.test.mjs extended to ref hops. Mutations: hydrate (5), store.mjs:247 (money minor units), snapshot-miss throws.
**S3b - Rules and step values on the snapshot.** ~+150/-80: `rules.mjs:180-208` (plan on probe), `interp.mjs` `refValue/exprCtx/resolve/interpolate` (load per resolve; `interpolate` split into collect + format so no async work sits in `String#replace`).
**S3c - Render, perms and field hooks on prefetched data.** ~+250/-120: `fields.mjs:150-152` (`validate` drops `store`; `format/input` use `ctx.label/options`), `auth.mjs:81,89-95` (`perms.prime(rows)` batch-loads own one-hop parents; `ownWhere` becomes an explicit async loader), `render.mjs:106-172`, `render/{list,detail,dashboard,pages}.mjs`, routes preload labels with one `labelsFor(pairs)` query per page. Registry contract test updated for the new hook shapes.

**S4 - Await-first conversion (behaviour no-op; sync store still returns values).**
- S4a routes + server + boot + auth session: `await store.*`; `interp.attempt(fn)` gives `fn` the tx view (initially `store` itself); ~150 changed lines in ~10 files.
- S4b interp + blocks + outbox: `runSteps/fireEvents/resolve/text/attempt` async, block `run` awaited, `Store#transaction` awaits `fn`; ~250 lines in 4 files; mutations in interp/blocks re-pointed (20).
- S4c plugins (12 files, ~130 lines), FORMAT.md "Plugins" contract, types.d.ts, `check/plugins.mjs` marker rule; the plugin fixtures in tests/registry.test.mjs.
- S4d tests: `await` at ~370 sites (mechanical, regex-assisted), `Store.open`.
- New arch gate (lands in S4a, tightened per PR): masked-source regex "no store call (`store.<method>(`) without `await`" over runtime/ and plugins, so conversion cannot regress.

**S5 - Flip to an async Driver.** ~+300/-80, ~8 files. Driver methods return Promises; SQLite driver wraps the sync handle with the FIFO mutex (section 3); `Store` methods are `async`; `Store.open`; `serve()` `{ ready }`; outbox claim (state.mjs). Tests: concurrency suite (two `attempt`s with an `await` inside a block must not interleave; failed tx invisible to a concurrent reader; deadlock-guard), mutations: mutex removed, COMMIT on error, claim removed.

**S6 - `runtime/driver/postgres.mjs`** (optional dep `pg` via literal-free dynamic `import`, so the zero-runtime-deps rule and arch dynamic-import exemption hold; ~250 lines, maybe split with `driver/pgtypes.mjs`): pool, client-per-tx, advisory lock, type parsers (int8/numeric -> Number), schema per app via `search_path`, `--db postgres://...` in cli.mjs:32. CI: `services: postgres`, run tests + `verify/run.mjs` on both drivers (README steps 2-3).
**S7 - bench before/after + load test** (README step 4). Sqlite-only tests (`EXPLAIN QUERY PLAN` perf.test.mjs:104,106, `PRAGMA` tests) stay in a `@sqlite` group.

## 6. Dialect list for step 2 (every SQLite-specific construct in the store layer)

| # | construct | where | Postgres handling |
|---|---|---|---|
| 1 | `INTEGER PRIMARY KEY AUTOINCREMENT` | store.mjs:59, :84 | `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` |
| 2 | `lastInsertRowid` | store.mjs:146, state.mjs:8 | `INSERT ... RETURNING id`; `DEFAULT VALUES` (:144) is valid pg |
| 3 | `.changes` | store.mjs:72 | `rowCount` |
| 4 | `INTEGER` for int/bool/money (`sql:` in fields.mjs:113,119,128; plugin shop/loyalty.mjs:12) | `sqlType` spec.mjs:215 | map to `BIGINT` (money in minor units overflows int4 at ~21M major units); `TEXT` stays; no REAL columns exist |
| 5 | `PRAGMA table_info` | store.mjs:64 | `information_schema.columns` |
| 6 | `sqlite_master` (table, index) | store.mjs:56, migrate.mjs:52 (`LIKE 'idx\_%' ESCAPE '\'`) | `to_regclass`/`pg_indexes` by schema |
| 7 | index name length | migrate.mjs:26 `idx_<table>_<cols>` | pg truncates identifiers at 63 bytes, so `existing.includes(name)` never matches and the index is recreated/logged on every boot: truncate+hash in the dialect |
| 8 | `INSERT OR REPLACE` (only `ON CONFLICT`-style construct) | state.mjs:25 | `INSERT ... ON CONFLICT (id) DO UPDATE SET user=EXCLUDED.user, at=EXCLUDED.at` |
| 9 | unquoted `user` column, reserved in pg | store.mjs:87, state.mjs:25,30 | quote (`"user"`) |
| 10 | unquoted mixed-case `_outbox` columns (`updatedAt`) vs quoted `"updatedAt"` in DML | store.mjs:84-85, state.mjs:7,20 | pg folds unquoted to `updatedat`; quote all in DDL and `SELECT *` keys, or the update never matches |
| 11 | `LOWER(col) LIKE ? ESCAPE '\'` | query.mjs:28,65 | valid; but SQLite `LOWER` is ASCII-only, pg is Unicode-aware while the bound value is `toLowerCase()`d in JS: results differ for non-ASCII; `likeSafe` :9 escaping stays correct with `ESCAPE '\'` |
| 12 | `LOWER(col)=LOWER(?)` uniqueness | store.mjs:185 | same Unicode difference; consider `citext`-free comparison in JS collation |
| 13 | `strftime('%Y-%m', col)` (`UNITS` :10) | query.mjs:194 | `col` is TEXT ISO: portable `SUBSTR(col,1,7|10|4)` (what `aggregateInMemory` :211 already does) or `to_char(col::timestamp,...)` (throws on malformed text) |
| 14 | `IFNULL` | aggsql.mjs:86 | `COALESCE` (valid on both) |
| 15 | integer booleans: `CASE ... <> 0`, `NOT (x)`, `(a AND b)` over 0/1, `(as = bs)` inside `CASE THEN 1` | aggsql.mjs:68,88,91,101-103,146,162 | pg is strictly typed: `NOT`/`AND` need boolean, `<> 0` on a boolean errors; emit `CASE WHEN cmp THEN 1 ELSE 0 END` wrappers and `(x <> 0)` uniformly |
| 16 | `ref` columns are TEXT, ids are INTEGER: values are bound as `String()` (`coerce`, fields.mjs:149; aggsql.mjs:147,160; hydrate.mjs:55-64; query.mjs:110-116) and compared to `"via"` without a join | | pg has no cross-type `text = integer`: every ref bind must stay text, `id` binds stay numbers (query.mjs:18 types `id` as int; `auth.mjs:89-95` passes ids into `in`); a CAST-free design works only if the driver binds by declared type, so keep `String()` for refs and add a test that a numeric bind on a ref column fails loudly. (No `typeof`/`CAST` appears in SQL text today.) |
| 17 | `?` placeholders (all sites), `IN (?,?,...)` chunk 5000 | query.mjs:103,125; aggsql.mjs:28,161 | rewrite to `$n` in the driver (no `?` occurs inside SQL literals) or `= ANY($1)`; pg limit 65535 params, chunk stays valid |
| 18 | `ORDER BY "col"` NULL order and ties | query.mjs:75,204, :125 (`ORDER BY id DESC`) | SQLite: NULLs smallest; pg: NULLs largest. Emit `NULLS FIRST/LAST` to match, add `id` tie-break ("stable ordering of ties", README step 2); default text collation differs (SQLite BINARY vs pg locale): `COLLATE "C"` on ordered text columns |
| 19 | result types: `COUNT`/`SUM` return bigint/numeric strings, `AVG` numeric (SQLite: int/float) | query.mjs:94,197-206; aggsql.mjs:128-138 (`Number(...)` already wraps) | `aggregate()` rows go to JSON/dashboard (routes/views.mjs:24-46): normalise to Number in the driver; keep benchmark JSON byte-identical |
| 20 | `SELECT *` bigint columns (`id`, ints, money) come back as strings from `pg` | every read | type parser `int8 -> Number` (safe below 2^53) |
| 21 | `BEGIN` deferred / no isolation choice | store.mjs:213-215 | `BEGIN` + advisory lock (section 3), `ROLLBACK` |
| 22 | table name `entity.toLowerCase()` incl. `"order"` | store.mjs:53,144 and every builder | already always quoted; only the unquoted spots in rows 9-10 break; entities differing only in case collide on both engines |
| 23 | read-modify-write atomicity (not syntax) | blocks.mjs:309-317 | see section 3 |
| 24 | `ALTER TABLE ADD COLUMN`, `CREATE/DROP INDEX IF EXISTS` | store.mjs:67, migrate.mjs:59,65 | valid; qualify with the app schema |

## 7. Recommendation and risks

**Recommendation: C4.** Ship S1 (sync `Driver` seam) and S2 (dialect) first: they are behaviour-neutral, unblock the arch gate that keeps SQL out of everything but the driver, and let the Postgres SQL be reviewed as text. Then S3 (pure evaluation over a prefetched snapshot) while the driver is still sync: it is the only stage that changes semantics, so it should be verified against the byte-identical benchmark answers before any `await` appears, and it is the only option that makes the invariant enforceable (a "zero driver calls during evaluate" gate). Then await-first (S4) and the flip (S5), so the async change is a ~300-line PR. Reject A (invariant erased, atomic ~2.5k-line PR, snapshot inconsistency) and C2 as a product (event-loop blocking); use C2 only, if wanted, as a throwaway spike to validate the pg dialect before S5.

Risks (most to least serious):
1. **Silent semantic drift in S3**: over-/under-fetch in the plan (a miss must throw, never silently query), cycle-error text, probe-row (`id 0`) rules, ordering of children for float sums (hydrate.mjs comment :107-110 depends on `ORDER BY id DESC`). Mitigation: keep the old lazy `ctx` behind a test-only flag for one release and diff old vs new on all 104 apps' hydrated rows.
2. **Lost transaction isolation**: SQLite's implicit serial execution disappears in S5 and never existed on pg; read-modify-write blocks and plugins (`db.adjust`, poker, chess, strategy) are the exposure. Mitigation: mutex on SQLite, advisory lock v1 on pg, concurrency tests with mutations.
3. **Outbox double delivery** with concurrent flushes (already latent).
4. **Benchmark byte-identity** under S2's tie-break and NULL ordering, and pg numeric result typing (rows 18-20).
5. **Plugin ecosystem**: every store-touching plugin needs `await`; forgetting one on an async driver yields `undefined` fields, not an exception (a Promise has no `.tokens`); mitigations: the no-unawaited-call arch gate, the checker's plugin marker, and returning a store facade whose methods return a `Promise` subclass that throws on property access in test mode.
6. **Gate mechanics**: 87/143 mutations must be re-pointed; module budget 300 lines (store.mjs is 298 today, so S1/S2 must move code out, e.g. `migrate` DDL to the driver); 100% line coverage means the pg dialect object needs golden tests without a server; CI cost of running 699 checks twice; `mutate.mjs` needs an exclusive tree.
7. **Boot path**: `serve()` sync contract used by cli.mjs, tests/helpers.mjs and verify/run.mjs; `ready` promise must not change ports/timers behaviour (`noTimers`).
8. **pg-only surprises**: identifier truncation (row 7), reserved words (row 9), Unicode `LOWER`, int8-as-string, `search_path` per app, migrations racing across instances (needs the same advisory lock).
