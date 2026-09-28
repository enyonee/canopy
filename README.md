# Canopy

**Applications as a closed graph of effects with pure leaves.** A language model writes one
JSON document per app. The runtime derives the schema, migrations, routes, screens, permissions
and outgoing effects from that document. Changing the app later is a patch to one node, not
another rewrite.

```
app.json ──► checker ──► SQLite schema + migrations
                     ├─► routes, forms, lists, dashboards (server-rendered HTML or JSON)
                     ├─► roles, ownership, state machines, rules
                     └─► outbox: HTTP, mail, SMS, payments — delivered after commit
```

[![CI](https://github.com/enyonee/canopy/actions/workflows/ci.yml/badge.svg)](https://github.com/enyonee/canopy/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![WebGen-Bench](https://img.shields.io/badge/WebGen--Bench-101%2F101%20tasks-brightgreen)

## The invariant

> **Every effect is a node of the graph. Every computation is a pure leaf. There is no third thing.**

The graph is closed. You can answer statically who sees what, what happens on an event and
where a request goes. A leaf (an expression, or a pure function in a plugin) has access to
nothing, so it cannot lie about what it does. Canopy closes **access**, not arithmetic.

## Status (28 September 2026)

| | |
|---|---|
| WebGen-Bench tasks covered | **101 / 101**: one app per task, `webgen-bench/000001` … `000101` |
| Apps in the repo | **104**: the 101 tasks, two hand-written references (`shop`, `crm`) with three patch-based changes each, and `tictactoe` (the widget reference) |
| Acceptance checks | **699 / 699** green (`npm run verify`) |
| Runtime tests | **240**, 100 % line coverage across 56 modules |
| Mutation gate | **122 / 122** mutants killed |
| Types | `tsc --checkJs`, clean |
| Runtime size | ~4.4k lines, zero runtime dependencies (Node 22 built-ins, `node:sqlite`) |

Each app ships `checks.mjs`, with one check per `ui_instruct` case of its benchmark task, and
`NOTES.md`, which records every case that was weakened and every gap in the format. The
per-app table and the history of each round are in [REPORT.md](REPORT.md) (Russian).

**Caveat.** The checks were written by the same agents that wrote the graphs. They are
acceptance tests over HTTP (and headless Chrome for widgets), not the benchmark's own
browser-agent evaluation.

## A taste of the format

```json
{
  "app": "todo",
  "task": "webgen-bench/000080",
  "theme": { "background": "lavender", "accent": "indigo" },
  "data": {
    "Task": {
      "title": "text!",
      "notes": "longtext",
      "done": "bool=false",
      "createdAt": "time=now",
      "priority": "enum[low,normal,high]=normal"
    }
  },
  "views": "auto",
  "override": {
    "Task.list": { "search": ["title", "notes"], "rowActions": ["toggle", "edit", "delete"] }
  },
  "actions": [ { "name": "toggle", "in": "Task", "do": [ { "block": "db.toggle", "field": "done" } ] } ]
}
```

That document is the whole app: list, search, filters, forms, detail pages, CSV export, JSON
API and a migration-managed SQLite file. Anything derivable is left out; the model writes only
where the app departs from the defaults.

What the format covers ([docs/FORMAT.md](docs/FORMAT.md) is the full reference):

- **Data**: typed fields (`text`, `money`, `date`, `time`, `enum`, `ref`, `file`, `image`, `password`, …)
  and derived fields (`total := sum(OrderItem: qty * price)`) in a closed, statically checked
  expression algebra with correlated aggregates.
- **Behaviour**: `actions` and `events` made of steps from a 14-block catalog (`db.adjust`,
  `db.ensure`, `db.each`, `http.send`, `mail.send`, …); `states` (transitions guarded by status
  and role); `schedule` (timers); `rules` (checks, including compound uniqueness), enforced on
  **every** write path: forms, blocks, plugins and seed.
- **Access**: `roles` with a permission matrix, sessions and ownership
  (`own`, `own` + `all`, multi-field and one-hop owners), and per-field `private` redaction.
- **Screens**: derived list, form and detail pages, shaped by `override`; saved `lists`;
  `dashboards` with cards, grouped tables and SVG charts; `pages` with live sections; site-wide
  `search`. Every route also answers JSON on `Accept: application/json`.
- **Effects**: an outbox. HTTP, mail, SMS/WhatsApp and a sandbox card gateway are delivered only
  after the transaction commits, with status and retry at `/outbox`.
- **Plugins**: ES modules next to an app, registering field kinds, functions, blocks,
  transports or **client widgets** under the same contracts as the built-ins. Game rules
  (chess legality, poker hand ranking, 2048 merges) live in server-side plugin blocks. A widget
  only renders state and posts intents to the graph's own actions.

## Quick start

Requires Node 22+.

```bash
git clone https://github.com/enyonee/canopy && cd canopy
node runtime/run.mjs apps/shop/app.json --check        # validate a graph
node runtime/run.mjs apps/shop/app.json --port 8901    # serve it (admin@shop.test / admin123)
node runtime/run.mjs apps/chess/app.json --port 8902   # a widget app

npm install              # dev-only: typescript for the type gate
npm test                 # runtime tests, including the architecture gates
npm run verify           # every app's acceptance checks (+ patch-based changes)
node verify/run.mjs chess poker   # only some apps
npm run gate             # tests + coverage + types + mutations
```

An app is a directory: `app.json`, `checks.mjs`, `NOTES.md`, optional `plugins/`, and at run
time `data.sqlite`, `trace.jsonl` (every step and effect) and `session.key`. See [RUN.md](RUN.md).

## Architecture

The runtime is built in layers, and the layers are enforced by tests, not by convention
([runtime/ARCHITECTURE.md](runtime/ARCHITECTURE.md)):

```
cli / server ─ thin HTTP shell
routes/      ─ one module per route group, handle(ctx) → true | undefined
render/      ─ list, form, detail, dashboard, pages          interp.mjs ─ step interpreter, no HTTP
check/       ─ one checker per node kind                     boot.mjs   ─ identity + seed
store.mjs + store/ (query, state, rules) ─ SQLite, the only writer, rules on every write
registry ─ fields · blocks · transports · functions · widgets (built-ins + plugins)
expr · spec · fields · functions ─ leaves
```

## Architecture gates

The runtime's structure is enforced by tests rather than by review: each rule below is a
failing test in `tests/arch.test.mjs`, part of `npm test`.

- **Layering**: an explicit allow-list of which module may import which, plus which modules may
  touch `node:sqlite`, `node:http` and `fs`. No cycles.
- **Budgets**: at most 300 lines per module and 60 per function.
- **No swallowed errors**: an empty `catch`, or a `catch` that turns an error into success,
  fails unless it carries `// allow-swallow: <reason>`. Rules whose expression throws **refuse**
  the write (fail closed).
- **No leftovers**: no `TODO`/`FIXME`, `console.log`, `debugger` or commented-out code.
- **No dead exports**: every export must be imported somewhere.
- **The format is a registry**: the node kinds in the checker must equal the node kinds
  documented in `docs/FORMAT.md`. Each needs a checker module and a test that names it. Every
  registry entry, built-in or plugin, must carry its contract keys.
- **Proof, not coverage**: 100 % lines per module by name (`tests/coverage.mjs`), and a mutation
  gate (`tests/mutate.mjs`) that breaks the code on purpose and requires a test to notice.

## Repository map

| path | what |
|---|---|
| `runtime/` | the interpreter, checker, store, renderer, routes |
| `docs/FORMAT.md` | the `app.json` reference, the document an app-writing model reads |
| `apps/<name>/` | one app per benchmark task: `app.json`, `checks.mjs`, `NOTES.md`, `plugins/` |
| `tasks/` | the 101 WebGen-Bench test tasks (instruction + `ui_instruct` cases) |
| `plugins/` | shared plugins: `payment.mjs` (sandbox card gateway), `messaging.mjs` (SMS, WhatsApp) |
| `verify/` | the acceptance harness, an HTTP sink for outgoing effects, and a zero-dependency headless-Chrome driver |
| `tests/` | runtime tests, architecture gates, coverage and mutation gates |
| `REPORT.md`, `TESTS.md` | round-by-round report and test inventory (Russian) |
| `docs/PLAN.ru.md` | the original plan: experiment design, decisions and open questions (Russian) |

## What Canopy does not promise

- **A product UI.** The derived screens are a scaffold, not a designed interface. Widgets cover
  interactive cores (boards, canvases, editors); bespoke layouts are out of scope.
- **Conditional permissions per row by parent status** (e.g. "order lines are frozen once the
  order is placed"), background delivery (the outbox flushes within the request; see the roadmap), real SMTP or
  SMS gateways (the outbox records messages; HTTP is really sent).
- **Isolation for plugin code.** Plugins are trusted modules. The closed part is the graph.

## Roadmap

**Runtime performance** (in progress). Measured on 500 customers / 2000 orders / 10 000 items:
a list with derived aggregates takes ~1.6 s and a dashboard ~3.6 s. That time goes to SQLite
full scans and one aggregate query per row, not to JavaScript. The fixes: indexes derived from
the graph, derived fields computed only for the visible page, batched child aggregates, and a
prepared-statement cache. A query-count gate in the test suite will keep a list page at O(1)
queries. Every number is measured before and after, and the JSON answers must stay
byte-identical.

**PostgreSQL as a second storage driver.** SQLite stays the default for development, tests and
single-instance apps. Postgres is for deployments that need several instances, many concurrent
writers, replication or online backups. Graphs never contain SQL, so apps do not change. Plan:
1. an async driver interface over the current SQLite store, with everything still green (the
   store, step interpreter, blocks and plugins are synchronous today; this is the main cost);
2. a Postgres driver as an optional dependency, loaded only when configured (dialect: month
   bucketing, `LIKE … ESCAPE`, identity columns, stable ordering of ties);
3. the full acceptance suite (699 checks) run against both drivers in CI, one schema per app;
4. the same benchmark before and after, plus a load test.

It has to come after the performance round. With one query per row, every round trip to a
database server would multiply the current latency instead of removing it.

**Horizontal scaling.** Today one app is one Node process with one SQLite file. A single
process on one core sustains ~1.8k reads/s and ~1.7k writes/s at 50 concurrent clients
(p99 ≈ 70 ms). The single SQLite writer is not the limit yet; the one process is. Next steps:
- **several instances of one app behind a load balancer** on the Postgres driver. Sessions
  already live in the database rather than in memory, so any instance can serve any request;
- **outbox delivery by workers**: claim rows with `FOR UPDATE SKIP LOCKED`, keep delivering
  after the request returns, retry with backoff, deliver once across instances;
- **schedules with one leader** (an advisory lock), so a timer fires once per cluster;
- **files in object storage** (S3-compatible) instead of the app directory;
- **many apps per process** for dense hosting. Each process costs ~75 MB of Node baseline, and
  an extra app in a shared process would cost a few MB;
- a load test with 1, 2 and 4 instances as the acceptance number for this item.

## The original plan, and what is not done yet

Canopy started as a measurable hypothesis: *does a closed, block-based format make an app
cheaper to build and, above all, cheaper to change, than ordinary code?* The primary metric is
the **cost of the lifecycle**: tests passed across one build plus three fixed changes (a second
role with reduced access, a period summary screen, an HTTP notification with delivery status),
with tokens and fix-loop iterations per stage.

Done: the format, the runtime, all 101 tasks as apps, lifecycle changes as JSON patches on the
reference apps.

The full design is in [docs/PLAN.ru.md](docs/PLAN.ru.md).

Not done yet: the head-to-head experiment. That means the same tasks written as ordinary code
and with a batteries-included framework, the benchmark's own hidden tests run by a browser
agent, and token and regression curves per stage. Until those numbers exist, Canopy's advantage
is a claim, not a result.

## License

[MIT](LICENSE)
