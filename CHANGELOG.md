# Changelog

Versions follow the roadmap: a minor bump when a roadmap item moves, a patch bump for work
within the current goal. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

## Unreleased

- `AGENTS.md`, `CONTRIBUTING.md`, pull request and issue templates, this changelog.
- README roadmap: runtime performance, PostgreSQL as a second driver, horizontal scaling,
  a production connector library.

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

Measured with the same graph, data and requests (p50, ms; one Node process):

| route | 2000 orders, before | after | 8000 orders, before | after |
|---|---|---|---|---|
| `GET /Order` | 1591 | 3.7 | 24 758 | 3.3 |
| `GET /Order?status=paid` | 413 | 3.1 | 6197 | 3.4 |
| `GET /Order?sort=total` (derived) | 1605 | 17 | 24 666 | 52 |
| `GET /Customer` | 144 | 1.2 | 1997 | 1.8 |
| `GET /dashboard/sales` | 3597 | 32 | 51 570 | 117 |
| `GET /Order.csv` | 2566 | 79 | 41 495 | 435 |
| `GET /Order/1` | 1.4 | 0.6 | 8.1 | 0.7 |
| `POST /Item` | 1.6 | 1.4 | 2.5 | 1.4 |

One customer with 4000 orders, `GET /Order.csv`: 293 s → 0.1 s (2000 orders on 0.1.0: 515 s);
with 35 000 orders: 0.5 s. Under load (50 clients), detail reads went from 3413 to 5016 req/s
and writes from 3013 to 3217 req/s. Boot and memory are unchanged (~0.3 s, ~75 MB).

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
