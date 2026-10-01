# Working on Canopy

Rules for coding agents (and humans) changing this repository. Read this file, then
[README.md](README.md), [docs/FORMAT.md](docs/FORMAT.md) and
[runtime/ARCHITECTURE.md](runtime/ARCHITECTURE.md) before the first edit.

## What this repo is

Canopy runs applications described by one JSON document (`app.json`). The runtime derives
the schema, migrations, routes, screens, permissions and outgoing effects from it.

**The invariant: every effect is a node of the graph, every computation is a pure leaf.**
Any change that lets an app reach storage, the network or the clock outside a graph node
breaks the project, however convenient it looks.

When a task says "the app", it means an app under `apps/<name>/`. "The runtime" is
`runtime/`, and "the format" is the `app.json` language documented in `docs/FORMAT.md`.

## Layout

| path | what | who edits it |
|---|---|---|
| `runtime/` | checker, store, interpreter, renderer, routes | runtime changes only, under the gates below |
| `runtime/check/` | one checker module per top-level node kind | with every format change |
| `runtime/routes/`, `runtime/render/` | HTTP routes and screens | |
| `runtime/store.mjs`, `runtime/store/` | schema, queries, rules, outbox, sessions | the only code that asks the database anything, and only through `this.drv` |
| `runtime/driver.mjs`, `runtime/driver/` | the storage `Driver` (SQLite today) | the only code that names the engine: `node:sqlite`, `PRAGMA`, `sqlite_master`, `.prepare(` |
| `docs/FORMAT.md` | the format reference; what an app-writing model reads | with every format change |
| `apps/<name>/` | `app.json`, `checks.mjs`, `NOTES.md`, optional `plugins/`, `*.client.mjs` | per app |
| `tasks/` | WebGen-Bench task definitions | never |
| `plugins/` | shared plugins (payment sandbox, messaging) | |
| `verify/` | acceptance harness, HTTP sink, headless-Chrome driver | |
| `tests/` | runtime tests, architecture, coverage and mutation gates | with every runtime change |

## Commands

```bash
npm install                                   # dev-only dependency: typescript
node runtime/run.mjs apps/<name>/app.json --check        # validate a graph
node runtime/run.mjs apps/<name>/app.json --port 8901    # serve it
npm test                                      # runtime tests + architecture gates
npm run test:async                            # the same suite with every external store call answering a Promise (S4)
npm run coverage                              # 100 % lines per runtime module
npm run types                                 # tsc --checkJs
npm run mutate                                # mutation gate (hours; rewrites runtime files while it runs)
MUTATE_SHARD=3/8 npm run mutate               # only shard 3 of 8 (CI runs all 8 in parallel on every PR)
npm run gate                                  # all of the above
node verify/run.mjs                           # acceptance checks of every app (+ patch-based changes)
node verify/run.mjs <app> [<app>…]            # only some apps
```

- `tests/mutate.mjs` edits runtime files in place while it runs. Run nothing else against the
  runtime until it finishes. It restores the file on SIGINT/SIGTERM, but not on SIGKILL.
- `verify/run.mjs` listens on port 8999 (outgoing-HTTP sink) and serves apps from 8910 upward.
  Parallel runs need `AG_SINK_PORT`/`AG_PORT`. Some apps' connectors are hard-wired to
  `127.0.0.1:8999`, so those apps only pass with the default sink port.

## Rules for runtime changes

The gates in `tests/arch.test.mjs` are part of `npm test`. Fix the code, never the gate:

- **Layers**: a module imports only what the allow-list in `tests/arch.test.mjs` names. A new
  module goes in at the right layer. Never make an edge legal just to get past the test.
- **Budgets**: at most 300 lines per module and 60 per function. Split the code; do not raise
  the numbers.
- **Errors**: no empty `catch`, and no `catch` that turns an error into success. A deliberate
  exception carries `// allow-swallow: <reason>`. Anything that validates data fails closed.
- **No leftovers**: no `TODO`, `console.log` outside startup, `debugger`, commented-out code
  or unused exports.
- **A new node kind** means a row in `docs/FORMAT.md`, a checker in `runtime/check/`, and a
  test that names it. A new block, field kind, function, transport or widget means a registry
  entry with its contract keys.
- **Proof**: 100 % line coverage per module, and at least one mutation in `tests/mutate.mjs`
  for each new decision branch that matters. When you move code, re-point the mutations;
  never delete one to make the gate pass.
- **Types**: JSDoc plus `runtime/types.d.ts`; `npx tsc -p .` stays clean.
- **Await the store**: every call of a store method (`store.x(`, `tx.x(`, `ctx.store.x(`), of a loader (`perms.prime`, `ownWhere`,
  `interp.*`, …) and, in blocks and plugins, of `resolve`/`text`/`run`/`fireCreated` is `await`ed, even though SQLite still answers plain
  values: the pure schema lookups (`field`, `fieldAt`, `label`, `labelField`, `childVia`) and `within` are the only exceptions. A plugin
  with blocks exports `async: true`. Never hand an async function to `filter/some/every/find/sort/forEach`. `tests/arch.test.mjs` fails on
  both, `npm run test:async` finds what a regex cannot.
- The runtime has **zero runtime dependencies**. Adding one needs a discussion first (see
  CONTRIBUTING).
- **Performance** is measured, not assumed. Anything touching queries reports numbers before
  and after, and the JSON answers of the benchmark routes must stay byte-identical.

## Rules for apps

- One app per task: `app.json` with `"task": "webgen-bench/<id>"`, plus `checks.mjs` and
  `NOTES.md`.
- `checks.mjs` has one check per `ui_instruct` case, in order, plus the colour check when the
  task names colours. A check asserts the expected result the way a user would observe it:
  over HTTP, or in headless Chrome for widgets. A check that asserts nothing is worse than no
  check.
- `NOTES.md` has three sections: *Weakened cases*, *Misses* (tagged `node kind`/`connector`/
  `block`/`composition`/`field kind`) and *New for this app*. Never fake a feature with static
  text. If the format cannot express it, write that down.
- Domain logic (a chess engine, a scoring formula) goes in an app-local plugin: pure functions
  and blocks through the registry contracts. Widgets only render and post intents; the server
  stays the authority.
- Runtime crashes are runtime bugs. Report them; never work around them in the graph.

## Git

- Small commits, one logical change each. Messages so far are in Russian; either language is
  fine, but say *why*, not only *what*.
- `main` is protected: CI (tests, coverage, types, all acceptance checks) must pass, history is
  linear, force pushes are refused.
- Never rewrite published history, and never commit `data.sqlite`, `trace.jsonl`,
  `session.key`, `secrets.enc`, `secrets.key` or `files/`.
- Versioning is in [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).
