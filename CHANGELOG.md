# Changelog

Versions follow the roadmap: a minor bump when a roadmap item moves, a patch bump for work
within the current goal. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

## Unreleased

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
