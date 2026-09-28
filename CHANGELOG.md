# Changelog

Versions follow the roadmap: a minor bump when a roadmap item moves, a patch bump for work
within the current goal. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

## Unreleased

- **The outbox delivers each row once.** `flush` used to read every `queued` row, deliver them
  one by one and only then update them, so two overlapping flushes (two requests committing
  close together; later several instances) both delivered the same row. A row is now claimed by
  one atomic `UPDATE ... WHERE status='queued'` (`Store#outboxClaim`) and only the caller whose
  update changed the row delivers it: `queued → sending → sent|failed`.
- **Lease recovery.** A row stuck in `sending` for more than 60 s (the process died
  mid-delivery) is claimed again. Delivery is therefore exactly-once, and at-least-once across
  a crash; connectors should send an idempotency key.
- New column `_outbox.claimedAt`, added in place to databases made by earlier versions.
- Tests: concurrent flushes, lease before/after, in-place upgrade from the old DDL; six new
  mutations.

## 0.1.3 (2026-09-29)

Runtime performance, round 3. No change to any answer: the JSON responses and CSV exports of
the benchmark routes are byte-identical to 0.1.2 at both data sizes. One deliberate change in
the JS path: nested derived fields now share their caller's clock instead of reading their own
`new Date()`, as `runtime/expr.mjs` always promised ("an expression cannot cross midnight
halfway").

- **Derived fields and dates pushed into SQL** (`runtime/store/aggsql.mjs`, and the new
  `aggexpr.mjs` for the expression compiler). The body of `count`/`sum`/`avg`/`min`/`max` over
  a child may now contain, besides the child's stored `int`/`money`/`bool` fields:
  - a **derived scalar field** of the child (`Item.line := qty * price`, a derived bool),
    inlined when it stays exact (a money*money product, which needs real cent rounding, and an
    int fed by money still evaluate in JS);
  - a **derived or written-out aggregate** over a grandchild, as a correlated scalar subquery
    (`Customer.spent := sum(Order: total)` with `total := sum(Item: qty * price)`; also
    `sum(Order: count(Item))`). An empty inner group is 0 for `sum`/`count` and null for
    `min`/`max`, as in JS; an inner `avg` (a fraction) stays in JS;
  - **dates and times**: stored `date`/`time` fields and ISO literals in comparisons and
    `if(...)` conditions, and `min`/`max` over a date/time field (the stored text, as before).
    Text is compared exactly as `runtime/expr.mjs` compares it — as strings, whatever ISO shape
    a `time` was stored in. `today`/`now` compile too: they are bound from the evaluation's one
    clock (now read once per evaluation and handed to derived fields, hops and child rows), never
    from SQLite's clock.
  A customer with 5000 orders, `GET /Customer/<id>`: 146 → 14 ms (p50); `GET /Customer.csv`
  (201 customers): 75 → 18 ms; the wide-customer case of round 2: 36.6 → 3.3 ms. With
  the maintainer's own script (200 customers + one with 2000 orders): `/Customer` 102 → 15 ms,
  `/Customer/<wide>` 140 → 10 ms, `/Customer.csv` 148 → 21 ms.
- Compilation is bounded: nesting of derived fields, depth of subqueries and the work of one
  plan are capped, a derived cycle is not compiled (the JS path raises its own error, as
  before), and an integer beyond SQLite's `SUM` or JS's 2^53 falls back to the JS path for that
  aggregate at run time instead of throwing. Compiled plans are cached per AST node.
- **Known divergence, kept as shipped in 0.1.2:** a comparison of a *raw* money product with an
  exactly equal value (`count(Item: qty * price > disc)` with 3, 0.1 and 0.3) is decided on
  exact decimals in the SQL path and on doubles (0.30000000000000004) in the JS path. It is
  pinned by a test and not widened — a nested `min`/`max` over such a product is not compiled.
- **Memory**: RSS growth after a heavy dashboard/CSV request is a peak of allocations (V8 keeps
  a grown young generation), not retention. `Store#ctx()` now returns a class instance instead
  of an object with three closures, and a compiled aggregate's cache key is built once with its
  plan, not once per row. RSS after `/dashboard` + `/Order.csv` at 8000 orders: 127 → 121 MB
  (median of six runs); with the maintainer's script (2200 orders, 22 000 items + a wide
  customer) 188 → 160 MB after the round-2 code's 314 MB.
- `npm run bench`: scenario 4 (`bench/app2.json`) for the derived/date shapes.
- Tests 267 → 280, mutations 143 → 164. A property test draws random expression trees
  (ints, money, bools, dates, nullable columns, derived scalar and aggregate fields, `+ - *`,
  comparisons, `and`/`or`/`not`, `if`) over random rows, empty groups and NULLs, with a fixed
  seed, and asserts the SQL path equals the JS path for every function.

Measured by the maintainer with an independent script (200 customers × 10 orders × 5 items plus
one customer with 2000 orders × 10 items; fields with derived and nested aggregates, date
conditions, `max` over a date), p50 ms, two runs each, one Node process. Answers byte-identical to
0.1.2 at ×1 and ×4; `today`/`now` and five ISO shapes of `time` checked separately against the
0.1.2 JS path:

| route | 0.1.2 | 0.1.3 |
|---|---|---|
| `GET /Customer` | 102–106 | 14.5 |
| `GET /Customer/<2000 orders>` | 142–148 | 10.2 |
| `GET /Customer.csv` | 151–156 | 21 |
| `GET /Customer?sort=spent` | 144–147 | 21 |
| `GET /Order.csv` | 127–129 | 60 |
| `GET /Order?sort=total` | 103–105 | 40 |
| RSS after these requests (after GC) | 338 MB | 170 MB |

## 0.1.2 (2026-09-28)

Runtime performance, round 2. No change to any answer except one fix below: the JSON responses
of 13 benchmark routes, the wide-parent routes and the CSV exports are byte-identical to 0.1.1
at both data sizes; the only difference is the dashboard JSON money unit.

- **Aggregates pushed into SQL** (`runtime/store/aggsql.mjs`): `count`/`sum`/`avg`/`min`/`max`
  over a child with a direct `via` link, whose body is built only from the child's own stored
  `int`/`money`/`bool` fields (`+ - *`, comparisons, `and`/`or`/`not`, integer literals,
  `if(...)`), answers in one SQL query — a single row for `Store#get()`, one `GROUP BY` for a
  whole page — instead of fetching every child row and summing in JS. `total := sum(Item: qty
  * price)` on an order with 20 000 items: 30.7 ms → 2.0 ms (p50). Everything else (a derived
  field inside the body, `row.*` correlation, a hop through a reference, date/time, division
  anywhere in the body, a fractional literal, text/enum comparisons) still evaluates in JS,
  unchanged. Parity with the JS path — including money's minor-unit rounding, NULL
  propagation, and empty groups (`sum`/`count` are 0, `avg`/`min`/`max` are null) — is a
  property test (`tests/aggsql.test.mjs`) over random rows for every compilable shape,
  plus direct tests of the compiler's accept/reject boundary.
- **Memory regression from 0.1.1 fixed.** `hydratePage` now builds its aggregate cache (and
  fetches any raw child rows a non-compilable aggregate still needs) in chunks of 500 parent
  rows at a time, released between chunks, instead of once for the whole page — and with SQL
  aggregates above, most pages never fetch a child row into JS at all any more. RSS growth
  after `/dashboard` + `/Order.csv` at 40 000 orders (200 000 items): +87 MB (0.1.1) → +17 MB
  (this round), measured with the same script before and after a forced GC.
- `npm run bench` extended with both scenarios (`bench/run.mjs`); numbers above and the full
  table are in `TESTS.md`.
- **Fix**: `GET /dashboard/<id>` JSON answered a money card/table/chart aggregate in raw
  minor units (`6500000`) instead of the major units the rest of the JSON contract promises
  (`65000.00`); the HTML and CSV dashboard views were already correct. Cards, table metrics
  and chart metrics now convert the same way `rowJSON` already does for an ordinary field.
- `AGENTS.md`, `CONTRIBUTING.md`, pull request and issue templates, this changelog.
- README roadmap: runtime performance, PostgreSQL as a second driver, horizontal scaling,
  a production connector library.

Measured by the maintainer with the same scripts, graph, data and requests as 0.1.1 (p50, ms;
one Node process). One customer with 5000 orders, one order with 20 000 items:

| route | 0.1.1 | 0.1.2 |
|---|---|---|
| `GET /Order/<20 000 items>` | 30.6 | 2.8 |
| `GET /Customer/1` (5000 orders) | 55.9 | 42 |
| `GET /Customer` | 57.8 | 23.1 |
| `GET /Order` | 34.5 | 3.4 |
| `GET /Order?sort=total` (derived) | 60.7 | 24.8 |
| `GET /Order.csv` | 80.8 | 46 |
| `GET /Customer.csv` | 73.6 | 22.2 |
| wide order detail, 50 clients | 49 req/s, p99 5.3 s | 632 req/s, p99 189 ms |

On the 0.1.1 table graph at 8000 orders: `/dashboard/sales` 167 → 116 ms, `/Order.csv`
134 → 109 ms, resident memory after the heavy requests 254 → 183 MB (0.1.0: 158 MB).

Tests 256 → 267, mutations 134 → 143. All 699 acceptance checks pass.

## 0.1.1 (2026-09-28)

Runtime performance, round 1. No change to any answer: the JSON responses of 13 benchmark
routes and the CSV export are byte-identical before and after, at both data sizes below.

- **Indexes derived from the graph**: every `ref` column, `rules.unique` (single and compound),
  `states` status fields and list/dashboard `where` keys. They are created and dropped by the
  migration like columns.
- **Page before hydrate**: lists compute derived fields only for the rows on the current page.
  A sort or filter on a derived field still hydrates everything, correctly.
- **Batched aggregates**: one query per (child, link) per page, at every nesting depth, instead
  of one per row. Chunked below SQLite's parameter limit, and children keep the unbatched order
  so money sums round identically.
- **Labels without hydration**: a reference cell, CSV export or dashboard group reads only the
  target row's label. Before, it computed every derived field of the target, which made
  exports quadratic.
- **Prepared-statement cache** (bounded LRU).
- **Gates**: `tests/perf.test.mjs` checks the query count per page (O(1) in the number of
  rows), that the index is used, and that the batched and per-row paths agree. `npm run bench`
  reports latencies (informational).

Measured with the same graph, data and requests (p50, ms; one Node process). *Corrected
after release: the first published table came from a benchmark that wrote references as
`'1.0'`, so every aggregate was empty. The numbers below come from real links, and the answers
(non-zero sums and counts) are again byte-identical between 0.1.0 and 0.1.1.*

| route | 2000 orders, before | after | 8000 orders, before | after |
|---|---|---|---|---|
| `GET /Order` | 1564 | 1.9 | 22 020 | 5.1 |
| `GET /Order?status=paid` | 520 | 2.2 | 6072 | 2.0 |
| `GET /Order?sort=total` (derived) | 1790 | 29 | 23 364 | 104 |
| `GET /Customer` | 1629 | 5.4 | 24 320 | 5.5 |
| `GET /Customer?q=City 7` | 90 | 2.2 | 1230 | 9.4 |
| `GET /dashboard/sales` | 3104 | 60 | 45 679 | 260 |
| `GET /Order.csv` | 8439 | 42 | 112 133 | 188 |
| `GET /Order/1` | 4.4 | 0.4 | 16.6 | 1.1 |
| `POST /Item` | 1.5 | 1.2 | 1.2 | 1.0 |

One customer with 4000 orders, `GET /Order.csv`: 293 s → 0.1 s; with 35 000 orders: 0.5 s.
Under load (50 clients), detail reads went from 3413 to 5016 req/s and writes from 3013 to
3217 req/s. Boot is unchanged (~0.25 s).

**Known regression:** resident memory after heavy requests grew at the larger size (158 MB →
292 MB after the dashboard and CSV export), because batched children are held in memory for
the whole request. This is tracked for the next round.

Tests 240 → 256, mutations 122 → 134. All 699 acceptance checks pass.

## 0.1.0 (2026-09-28)

First public release.

- All 101 WebGen-Bench tasks as apps, plus the `shop`/`crm` references with patch-based
  lifecycle changes and the `tictactoe` widget reference: 104 apps, 699 acceptance checks.
- Runtime in enforced layers with zero runtime dependencies: typed and derived data, roles
  with ownership and per-field privacy, state machines, rules on every write path,
  actions/events/schedules, an outbox (HTTP, mail, SMS/WhatsApp, sandbox payments),
  dashboards with charts, site search, JSON on every route, plugins including client widgets.
- Gates: 240 tests, 100 % line coverage per module, 122/122 mutants killed, `tsc --checkJs`,
  architecture tests.
