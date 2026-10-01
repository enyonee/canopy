# Canopy

**A lightweight app runtime: one JSON document in, a working application out.** Canopy is
~4.9k lines of JavaScript with zero runtime dependencies. It runs one Node process and one
SQLite file per app, with no build step, no framework and no frontend bundle.

Applications are a closed graph of effects with pure leaves. A language model writes one
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

## Lightweight by design

Everything an app needs comes from the platform and one small runtime:

| | |
|---|---|
| Runtime code | ~4.9k lines, 270 KB of source |
| Runtime dependencies | **0**: Node 22 built-ins only (`node:sqlite`, `node:http`, `node:crypto`) |
| Build step | none; no bundler, transpiler or frontend toolchain |
| An app | one `app.json`: median **76 lines** (~5.7 KB) across the 104 apps in this repo |
| Storage | one SQLite file per app, migrated from the graph on start |
| Deploy unit | a directory: `app.json` + `data.sqlite` (+ plugins if the app has any) |
| Start-up | ~0.3 s from `node runtime/run.mjs` to the first answer |
| Memory | ~75 MB resident per app process, nearly all of it Node itself |
| Frontend | server-rendered HTML; optional widgets are 1–9 KB of unminified JS each |

`typescript` is the only dev dependency, used by the type gate. Nothing is installed to run an
app.

Being lightweight does not mean missing features. The same small runtime serves roles,
ownership, state machines, dashboards with charts, an outbox for HTTP, mail, SMS and payments,
a JSON API on every route and client widgets. All 101 WebGen-Bench tasks run on it.

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
| Runtime tests | **267**, 100 % line coverage across 59 modules |
| Mutation gate | **142 / 142** mutants killed |
| Types | `tsc --checkJs`, clean |
| Runtime size | ~4.9k lines, zero runtime dependencies (Node 22 built-ins, `node:sqlite`) |
| Performance | indexes, page-before-hydrate, batched aggregates compiled into SQL where exact (stored and derived fields, nested aggregates, dates), prepared-statement cache; `/Order` list on a 500/2000/10000-row bench graph: 1590 ms → ~10-15 ms p50; an order with 20 000 items: 30.7 ms → 2.0 ms p50 (`npm run bench`, `TESTS.md`) |

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
  after the transaction commits, with status and retry at `/outbox`. A failed delivery is retried with
  backoff when its operation is idempotent; a non-idempotent call that got no answer is `unknown` and waits
  for an operator; a provider that keeps failing trips a circuit breaker.
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
time `data.sqlite`, `trace.jsonl` (every step and effect) and `session.key` (plus `secrets.enc`/`secrets.key` once a secret is set, and `deploy.json` once a connector is switched). See [RUN.md](RUN.md).

## Architecture

The runtime is built in layers, and the layers are enforced by tests, not by convention
([runtime/ARCHITECTURE.md](runtime/ARCHITECTURE.md)):

```
cli / server ─ thin HTTP shell
routes/      ─ one module per route group, handle(ctx) → true | undefined
render/      ─ list, form, detail, dashboard, pages          interp.mjs ─ step interpreter, no HTTP
check/       ─ one checker per node kind                     boot.mjs   ─ identity + seed
store.mjs + store/ (query, state, rules, migrate) ─ SQLite, the only writer, rules on every write,
                          indexes derived from the graph, prepared-statement cache, batched aggregates
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
| `AGENTS.md`, `CONTRIBUTING.md` | how to work on the repo: layout, gates, rules for agents, pull requests, versions |
| `CHANGELOG.md` | release notes |
| `docs/PLAN.ru.md` | the original plan: experiment design, decisions and open questions (Russian) |

## What Canopy does not promise

- **A product UI.** The derived screens are a scaffold, not a designed interface. Widgets cover
  interactive cores (boards, canvases, editors); bespoke layouts are out of scope.
- **Conditional permissions per row by parent status** (e.g. "order lines are frozen once the
  order is placed"), delivery by several instances (retries and the breaker run in one process; see the roadmap), real SMTP or
  SMS gateways (the outbox records messages; HTTP is really sent).
- **Isolation for plugin code.** Plugins are trusted modules. The closed part is the graph.

## Roadmap

**Runtime performance.** The first round shipped in 0.1.1: indexes derived from the graph,
derived fields computed only for the visible page, batched child aggregates, labels without
hydrating the target row, and a prepared-statement cache. A query-count gate keeps a list page
at O(1) queries. On 2000 customers / 8000 orders / 40 000 items, an order list went from
22 s to 5 ms and a dashboard from 46 s to 0.26 s, with JSON answers byte-identical before
and after ([CHANGELOG.md](CHANGELOG.md)). The second round pushed `count`/`sum`/`avg`/`min`/`max`
over a child's own stored fields into SQL (a `GROUP BY` for a page, one query for a single
row) instead of fetching every child row and summing in JS — an order with 20 000 items:
30.7 ms → 2.0 ms (p50) — and fixed the round-1 memory regression along with it (RSS growth
after a heavy dashboard/CSV request at 40 000 orders: +87 MB → +17 MB), with the same
byte-identical JSON guarantee. The third round widened what compiles: a **derived scalar
field** of the child in the body (`Item.line := qty * price`), a **derived or written-out
aggregate** of the child as a correlated subquery (`Customer.spent := sum(Order: total)`
where `total := sum(Item: qty * price)`), and **dates and times** — stored `date`/`time`
fields and ISO literals in comparisons and `if(...)`, `min`/`max` over a date, `today` and
`now` bound from the evaluation's one clock. A customer with 5000 orders: `GET /Customer/<id>`
146 → 14 ms, `GET /Customer.csv` 75 → 18 ms (p50, `npm run bench`, scenario 4), answers
byte-identical, parity with the JS path checked by a property test over random expression trees.
What still falls back to JS: division and fractional literals (excluded on purpose — see
`TESTS.md`), a hop through a reference, a correlated `row.*`, text/enum comparisons, any
function but `if`, an `avg` inside an aggregate body (a fraction), a derived money*money
product, a nested `min`/`max` over a raw money product, and dashboard/chart metrics over a
derived field (they still hydrate every row before grouping). Next: pushing those dashboard
metrics into SQL, and streaming the CSV export.

**PostgreSQL as a second storage driver.** SQLite stays the default for development, tests and
single-instance apps. Postgres is for deployments that need several instances, many concurrent
writers, replication or online backups. Graphs never contain SQL, so apps do not change. The design is accepted and staged in [docs/POSTGRES.md](docs/POSTGRES.md). Plan:
1. an async driver interface over the current SQLite store, with everything still green (the
   store, step interpreter, blocks and plugins are synchronous today; this is the main cost).
   **In progress:** stage S1 landed (the store reaches SQLite only through a `Driver`,
   `runtime/driver/sqlite.mjs`; still synchronous, behaviour byte-identical); S2 to S5 are next;
2. a Postgres driver as an optional dependency, loaded only when configured (dialect: month
   bucketing, `LIKE … ESCAPE`, identity columns, stable ordering of ties);
3. the full acceptance suite (699 checks) run against both drivers in CI, one schema per app;
4. the same benchmark before and after, plus a load test.

It builds on the performance round: with O(1) queries per page, a round trip to a database
server costs a constant, not one per row.

**A production connector library.** Today the outbox knows HTTP, a stand mail transport, SMS/
WhatsApp recorded in the outbox, and a sandbox card gateway. For anyone to run real apps on
Canopy, the common services have to work out of the box, configured in the graph and never
coded:
- **Payments**: Stripe, PayPal, Adyen, YooKassa; checkout, refunds, subscriptions, signed
  webhooks for payment status.
- **Email**: SMTP, Amazon SES, SendGrid, Postmark, Mailgun; templates, bounces and unsubscribes.
- **Messaging and notifications**: Twilio SMS, WhatsApp Cloud API, Telegram bots, Slack,
  Discord, web push.
- **Sign-in**: OAuth/OIDC (Google, GitHub, Microsoft, Apple), SAML SSO, magic links, TOTP 2FA.
- **Files and media**: S3-compatible storage, image resizing, signed download links.
- **Calendars and scheduling**: Google Calendar, Microsoft 365, iCal feeds.
- **Maps and places**: geocoding, distance and "near me" queries.
- **Business systems**: HubSpot, Salesforce, Airtable, Google Sheets, Notion, Zapier and
  generic inbound/outbound webhooks.
- **AI**: LLM calls (Claude and others) as a block with a declared input/output schema, for
  classification, extraction and summaries inside a workflow.
- **Observability**: error reporting, metrics and structured logs of the step trace.

Every connector follows one contract, so each new one is cheap and safe:
- a declarative descriptor (auth, operations, input/output schemas, inbound events);
- secrets kept out of `app.json`, in an encrypted secret store configured per deployment;
- **sandbox by default**, with switching to live credentials as an explicit deployment action;
- idempotency keys, retries only for idempotent operations, timeouts and a circuit breaker;
- signature verification and deduplication for inbound webhooks;
- recorded responses for hermetic tests, and contract-drift detection when a provider's
  answer stops matching its schema.

**Status:** the design is accepted and staged in [docs/CONNECTORS.md](docs/CONNECTORS.md); stages C1,
C3, C2, C4, C5, C6 and C7 have landed, and with them the connector-library design is complete (the descriptor format, its checker and engine, the `connector.call` block, `http`
as a built-in descriptor, `drift` detection; retries and the circuit breaker; an encrypted secret store
and sandbox/live mode switched only by the command line; signed, deduplicated inbound webhooks at
`POST /hook/<connector>`; the first providers, Stripe, Postmark and Slack, as descriptors under `connectors/` that
run in a sandbox by default and are tested against hand-written fixtures, with the `apps/checkout` reference app; the
OpenAPI import, `run.mjs --import-openapi spec.json --name x`, writes a draft descriptor from a JSON spec and lists everything it
could not map; the settings screen at `/settings`, for an admin, shows each connector's mode, breaker, 24-hour counts and secret slots as set or MISSING,
sets, replaces and removes a secret without ever showing it, sends a sandbox test, and prints the command that switches a connector to live).

A settings screen for connectors and secrets means a non-programmer can connect an app to real services.

**Horizontal scaling.** Today one app is one Node process with one SQLite file. A single
process on one core sustains ~1.8k reads/s and ~1.7k writes/s at 50 concurrent clients
(p99 ≈ 70 ms). The single SQLite writer is not the limit yet; the one process is. Next steps:
- **several instances of one app behind a load balancer** on the Postgres driver. Sessions
  already live in the database rather than in memory, so any instance can serve any request;
- **outbox delivery by workers**: the claim part is done (a row is claimed by one atomic
  `UPDATE` before delivery, `queued → sending → sent|failed`, a 60 s lease recovers rows of a dead
  process: exactly-once, at-least-once across a crash). Next: claim with `FOR UPDATE SKIP LOCKED`
  on Postgres. Done: delivery continues after the request returns (a background flusher on an injectable
  clock), retries with exponential backoff, deterministic jitter and `Retry-After`, an `unknown` status for a
  non-idempotent call that got no answer, per-descriptor timeouts, and a persisted circuit breaker per
  connector. Next: the same flusher and breaker across instances, which needs the pg driver's row locks;
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); coding agents start with [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
