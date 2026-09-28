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
