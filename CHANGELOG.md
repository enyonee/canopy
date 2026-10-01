# Changelog

Versions follow the roadmap: a minor bump when a roadmap item moves, a patch bump for work
within the current goal. See [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

## Unreleased

- **The connector settings screen (connector library, stage C7, the last).** `GET /settings`, for an admin (`vc.settings`, like
  `/outbox`; a customer, a guest and a signed-out request get 403 on every method), linked next to Outbox: one card per
  connector with its kind, its mode (`deploy.json`), the breaker of each mode, the last 24 hours of its outbox (sent, failed,
  unknown, drift; one grouped query for all connectors, so the page costs the same number of queries for 1 or 12), each
  secret slot as **set** or **MISSING** (never a value, a length or a prefix), and the webhook path `/hook/<name>` (a path,
  never an origin built from the request's `Host`). A password field per slot sets or replaces a secret (an empty value
  changes nothing; the value goes to the encrypted store only and is not echoed, not in the redirect, not in the trace and
  masked in any error); removing is its own POST with a confirmation. "Send test" runs one operation through the sandbox
  (the descriptor's new optional `sandbox.test` `{"op", "input"}`, else its first operation with rules) and shows the
  status and the shape of the answer; never in live mode. Going live stays the command line, printed on the card. Every POST
  needs the same origin (`Origin`, else `Referer`, must name the request's `Host`): the app has no CSRF token. Also:
  `store.breakers()` is one query instead of one per breaker. New: `runtime/routes/settings.mjs`,
  `runtime/render/settings.mjs`, `store.outboxStats`, `tests/settings.test.mjs`, the ninth check of `apps/checkout`, 18 `C7:`
  mutations. With this, the connector-library design of `docs/CONNECTORS.md` is complete.

- **OpenAPI import (connector library, stage C6).** `node runtime/run.mjs --import-openapi spec.json --name x [--out
  connectors/x/descriptor.json]` turns an OpenAPI 3.0/3.1 document in JSON (YAML is out of scope: no dependencies) into a
  **draft** descriptor for a human to review and commit: `operationId` is the operation (sanitised, a clash numbered, else
  `<method>_<path>`), path, query and header parameters and a JSON or form body its `input` and request template, the first
  2xx JSON answer its `output`, `servers[0].url` the base (else `config.baseUrl`), an `apiKey` header, `bearer` or `basic`
  scheme a header with a secret slot; GET, PUT and DELETE are idempotent, POST and PATCH are not unless the operation has
  an idempotency header parameter, which is bound to the row's key. It is `live` only, with no sandbox rules. `$ref` is
  followed inside the document, a cycle is cut (that schema is `{}`) and named; `allOf` of objects is merged, a
  one-element `oneOf` unwrapped. **Nothing is guessed:** everything else (`oneOf` with several alternatives, callbacks,
  webhooks, `oauth2`, an API key in the query, cookies, multipart, optional query parameters, `nullable`, an external
  `$ref`, …) is printed on stderr as `not mapped: <pointer>: <why>`, and an operation the descriptor checker still refuses is
  left out and listed, so the result always passes. New: `runtime/connectors/openapi.mjs`, `oas_schema.mjs`,
  `oas_request.mjs`, `importCommand` in `admin.mjs`, `tests/connectors_openapi.test.mjs`,
  `tests/connectors_openapi_fuzz.test.mjs`, `tests/fixtures/openapi`, `tests/golden/openapi`. Gates: golden imports of five
  specs (descriptor and list), 600 generated specs and 1250 damaged fixtures that never throw, a round trip against the
  Postmark descriptor, 15 `C6:` mutations.

- **The first real providers (connector library, stage C5): Stripe, Postmark, Slack.** Three descriptors as data,
  `connectors/stripe`, `connectors/postmark` and `connectors/slack`, each sandbox by default (`"modes": ["sandbox",
  "live"]`): Stripe's PaymentIntents (create, retrieve, confirm), refunds, form-encoded bodies, the `Idempotency-Key`
  header and the `stripe` webhook signature with `payment_intent.succeeded`, `payment_intent.payment_failed` and
  `charge.refunded`; Postmark's `sendEmail` and `Bounce`/`SubscriptionChange` webhooks on `basic` auth; Slack's
  `chat.postMessage` and Events API with the `slack` v0 signature. Three generic engine features, none naming a
  provider: `request.encoding: "form"` (`metadata[k]`, `a[0]`), a per-operation `failure` rule that turns an HTTP 200
  whose body says `{"ok": false, "error": …}` into a failed delivery with a status the retry classifier, `Retry-After`
  and the breaker already understand (Slack's `ratelimited` is 429, `internal_error` 503, the rest 400), and for
  inbound: `challenge` (Slack's `url_verification`, the one deliberate echo: only after the signature, a bounded token,
  never an event), an `eventId` made of several fields or set per event (Postmark's `SubscriptionChange` has no id)
  and `require` (an event without the named values is answered and ignored, because an absent `@values.x` is dropped
  from a `where` and a payment made outside the app would have selected every paying order). The fixtures are
  **written by hand from the providers' documentation, not recorded** (`"recordedAt": null, "source": "docs"`); tests use
  `replayFetch`, which throws on a miss, and a scan keeps secrets out of the fixtures. The new reference app
  `apps/checkout` orders a product, pays through Stripe (sandbox), is marked paid only by the signed
  `payment_intent.succeeded` (also via `--connectors simulate`), sends the receipt through Postmark and a notice to
  staff through Slack (sandbox), and answers Slack's challenge. New: `runtime/connectors/form.mjs`,
  `connectors/`, `tests/providers.test.mjs`, `tests/connectors_c5.test.mjs`, `tests/replay.mjs`, `apps/checkout`.
  Gates: contract tests (sandbox against `output`, recording against sandbox shape, request against recording),
  45 `C5:` mutations. No network anywhere in tests or CI.

- **Inbound webhooks (connector library, stage C4).** A connector whose descriptor has an `inbound` block now
  receives a provider's webhooks at `POST /hook/<connector>`, a route that is exempt from the session gate and
  authenticated only by the descriptor's signature recipe: `stripe` (`t=…,v1=…`, several `v1`), `slack` (`v0`),
  a generic `hmac` (header, sha256/sha1, hex/base64, prefix, raw or timestamp-dot-raw) or `basic`. The body is read as
  bytes (1 MiB cap), the signature is verified before anything is parsed (constant time, `timingSafeEqual` after a
  length check, against the secret and its `.prev`; a replay window for timestamped schemes, default 300 s), and the
  answer is JSON only and never echoes the payload (401 for any signature problem, the reason only in the trace).
  The payload is validated against the descriptor's schema for its type (400, no dedup row); an unknown type is
  `200 {ignored:true}`. The event's steps and a dedup row `_inbound(connector|eventId)` run in **one transaction**:
  a duplicate is `200 {duplicate:true}`, a failing step or a crash before commit leaves no row and answers 500, so
  the provider's retry is processed exactly once. A graph event is `{"inbound": "<connector>.<type>", "do": […]}`
  (checked against the descriptor) and its steps get the payload as `@values.<name>`. The flusher prunes dedup rows
  older than 30 days. `--connectors simulate NAME EVENT --data f.json` signs a payload with the stored secret and
  posts it to the running app; verify seeds the secrets an app's checks export. The `shop` reference app marks a
  placed order paid on `payment.succeeded` (its change-3 patch now appends to `/events` instead of replacing it).
  New: `runtime/connectors/signature.mjs`, `runtime/connectors/inbound.mjs`, `runtime/routes/hooks.mjs`. Gates:
  `tests/inbound.test.mjs` (every recipe, the accept/reject matrix, exactly-once across a crash, the cap, no echo,
  no session, pruning, `simulate`), 42 `C4:` mutations.

- **Fixes: a step's `where` failed open on a key that resolved to nothing.** In `db.each` and `db.ensure`,
  a `where` key whose value was `undefined` or `''` (`"@values.order"` with no `order` submitted, `"@me"` with nobody
  signed in) was silently dropped by the store, which reads an absent filter as "no filter", so the block acted
  on every row the rest of the filter matched (an ensure created a row with the key missing). Now `db.each`
  matches no rows and `db.ensure` refuses (the action fails and rolls back, nothing is created); both trace
  `{ kind: 'where_unresolved', block, key }`. `null` is unchanged (`IS NULL`); list and route `?field=` filters
  are unchanged (absent = no filter). No app relied on the drop. Gates: `tests/blocks2.test.mjs` and four
  `Where:` mutations.

- **Render, permissions and field hooks read prefetched data (PostgreSQL roadmap, stage S3c).** After this stage
  nothing evaluates on the lazy `RowCtx` and no render, permission or field-hook code queries the store per
  cell: every page is a load phase in the route (`runtime/routes/load.mjs`) followed by pure formatting
  (`runtime/render/*`). `Store#labelsFor(pairs)` loads the labels of all reference cells of a page in one query
  per target entity (a miss throws `not loaded: label <Entity>#<id>`), `Store#optionsFor(targets)` the rows of the
  reference selects of a form, `perms.prime(user, entity, rows)` the parents a one-hop `own` path reads (one
  query per path; a check on a row nobody primed throws `not primed`), and `ownWhere` is now the explicit loader
  of which rows a viewer owns. A detail page's related rows, a static page's embedded lists and a dashboard's
  aggregates are loaded before the view renders (the dashboard's HTML, CSV and JSON now share one set of
  aggregates). **Plugin contract (field kinds):** `validate(v, f)` no longer receives the store (the kernel checks a
  reference's existence in `Store#checkValue`); `format(v, f, ctx)` gets `ctx = { esc, title, label(target, id),
  entity, row, labels, statusField }` and `input(f, v, ctx)` gets `ctx = { esc, options(target), entity, row }`
  (`ctx.store` is gone, and `ctx.label` is now the prefetched reference label; the title helper it used to be is
  `ctx.title`). No plugin field kind used the store, and none needed a change. Pages are byte-identical: a
  list page with reference columns and owned-parent permissions costs the same number of queries at 6 and at 60
  rows (`tests/perf.test.mjs`); the HTML, JSON and CSV of the benchmark routes of both benchmark graphs are
  byte-identical to before, and `npm run bench` is unchanged except `/Order.csv` (p50 20 ms -> 11 ms: one label
  query per page instead of one per cell); `tests/renderdiff.test.mjs` compares the HTML, JSON and CSV of every app's pages
  and its permission matrix with digests made before the stage. The lazy `RowCtx` path stays one more release
  behind the test-only `store.lazyEval`. Gates: `tests/snapshot.test.mjs` (a list, detail, form, page, search,
  dashboard, CSV cell and permission checks with the driver throwing on any call), `tests/auth.test.mjs`,
  the field-hook contract in `tests/arch.test.mjs`; `S3c:` mutations.

- **Secrets and sandbox/live mode (connector library, stage C2).** `{secret.name}` in a descriptor's headers
  and body is now read from an encrypted **secret store**, `secrets.enc` beside the database: one AES-256-GCM
  blob (even the names are hidden) under a key derived with HKDF from `CANOPY_MASTER_KEY` or a `secrets.key` file
  (0600, made by the first `set`); a wrong key or a changed byte fails closed with a clear message. A secret is
  resolved when the request is sent (never when the row is queued, never stored), only its current value signs a
  request (`name.prev` is kept for rotation), a missing one fails the delivery for good (not a retry, not a
  breaker failure), and its value is masked in every stored answer, error and trace line. Every connector now has
  a **mode**: descriptors gain `modes` (first is the default; none means live only, `http` is live only and `mail`
  sandbox only, so no existing app changes) and a `sandbox` block of ordered `when` rules over `input.*` that
  answer without the network, through the same output/result/retry path as a real provider. The mode lives in
  `deploy.json` beside the database and only the command line writes it: `--connectors status`,
  `--connectors live NAME --confirm` (refused without `--confirm` and while a secret its live requests read is not
  in the store), `--connectors sandbox NAME`, `--secrets set NAME` (value from stdin, never argv), `--secrets list`
  (names only), `--secrets rm NAME`. The circuit breaker is keyed by the real mode, `/outbox` shows each
  connector's mode, and a malformed `deploy.json` stops the app at boot. New: `runtime/secrets.mjs`,
  `runtime/deploy.mjs`, `runtime/admin.mjs`, `runtime/connectors/redact.mjs` and `runtime/connectors/sandbox.mjs`.
  Gates: `tests/secrets.test.mjs`, `tests/connectors_modes.test.mjs` (round trip, wrong key, tampering, rotation,
  missing secret, a redaction scan over the outbox, trace and database, sandbox rules, live switch, the commands),
  37 `C2:` mutations.

- **Delivery reliability (connector library, stage C3; roadmap "Horizontal scaling": retries and
  background delivery).** A failed delivery is now classified: a network error, a timeout, `429` and
  `5xx` are retryable, any other `4xx` is final. Only an operation with `idempotent: true` is retried;
  a non-idempotent one that got no answer (a timeout, a reset: the request may have landed) ends in the
  new status `unknown` and is never retried automatically, while one that certainly never left (DNS,
  connection refused) may be. A retry puts the row back to `queued` with `nextAttemptAt = now +
  min(capMs, baseMs·2^(attempts-1))`, less a deterministic jitter (from a hash of the idempotency key
  and the attempt: no `Math.random`) and never less than `Retry-After`; after `max` attempts (default
  5) it is `failed`. Descriptors may override with `retry` `{max, baseMs, capMs, jitter}` and
  `breaker` `{threshold, cooldownMs, maxCooldownMs}` (checked, fail closed) and name the header that
  carries the **idempotency key**, computed once when the row is queued (`idemKey`) and the same on every
  retry and after a lease takeover (`idempotency: {header}`). A request's timeout is the descriptor's
  `timeoutMs` (or the connector's `timeout`), never above half the lease. A persisted **circuit
  breaker** per connector and mode (`_breaker`) opens after N consecutive retryable failures (`4xx`
  never counts), spares the provider (its rows are not claimed, their `nextAttemptAt` moves to the end of
  the cooldown, no attempt is counted), lets exactly one probe through after the cooldown (an atomic
  claim) and doubles the cooldown, up to a maximum, when the probe fails. A background **flusher**
  (interval plus a one-shot to the earliest `nextAttemptAt`, unref'd, stopped on close) delivers due
  retries without a request; it is off under `AG_NO_TIMERS`/`noTimers`, so `verify` and the tests stay
  deterministic. One injectable clock `{now, setTimer, clear}` (`serve({clock})`) runs through the flush,
  the delivery, the request timeout and the flusher; the tests use a fake clock with `advance(ms)`, and
  a new architecture gate bans wall-clock reads and `Math.random` in the delivery modules. `/outbox`
  shows `unknown` rows with "Mark sent" (`POST /outbox/:id/sent`) and "Retry" (which now resets attempts
  and the schedule), the time of the next attempt of a waiting row, and the state of each breaker.
  `_outbox` gains `nextAttemptAt` and `idemKey` and a `_breaker` table is created, all in place in
  existing databases and quoted through the dialect. New: `runtime/connectors/backoff.mjs` (a pure leaf),
  `runtime/settle.mjs`, `runtime/clock.mjs`. Gates: `tests/backoff.test.mjs` (tables, jitter determinism,
  a property test of the breaker over random event sequences), `tests/reliability.test.mjs` (a scripted
  network and a fake clock: schedule, caps, Retry-After, `unknown`, no retry on 4xx, breaker
  open/half-open/probe/close/reopen with doubling, flusher, lease and retry, old database, an
  outage-recovery cycle on the server), 72 `C3:` mutations.
- **Derived fields evaluate over a prefetched snapshot (PostgreSQL roadmap, stage S3a).**
  Evaluating a derived field performs zero driver calls: a load phase (`runtime/store/hydrate.mjs`)
  first fetches everything the expression tree can touch, then `evaluate()` runs over a snapshot
  whose `get/rows/agg` are Map lookups (`runtime/store/snapshot.mjs`); a read that was not loaded
  throws `not loaded: <Entity.field>` and never queries. What to load is computed from the graph
  alone by the new pure `runtime/store/plan.mjs`: the derived closure (cycle-safe; the cycle error
  text is unchanged), one `WHERE id IN (...)` per reference hop per level, SQL-compiled aggregates
  through aggsql's batch, the child rows of the others level by level with the child entity's own
  plan (also for `row.*` correlation and for aggregates with no link back, which used to be
  fetched once per row). The query count depends on the size of the plan, not on the number of
  rows. `Store#get`, `hydrate`, `list`, `listPage`, `count`, `labelOf`, CSV and dashboards use it;
  rules and step values (S3b, below) and render/perms (S3c) still read through the lazy `RowCtx`.
- **Rules and step values evaluate over a prefetched snapshot (PostgreSQL roadmap, stage S3b).**
  `checkRules` and the step-value context of the interpreter (`refValue`, `exprCtx`, `resolve`,
  `interpolate`) perform zero driver calls while `evaluate()` runs, as derived fields did after S3a.
  The new `planExpr` (`runtime/store/plan.mjs`) plans the read-set of an expression (a rule's check, a
  step's `= expr` or `@path`) over a row of an entity; `Store#evalCtx` (`runtime/store/hydrate.mjs`)
  loads it for the row being written (for a rule, the probe row: id 0, or the stored row with the new
  values over it) or for the row the step runs on, inside the transaction the step runs in, so a step
  sees its own earlier writes. `interpolate` is now collect, load, format: nothing is loaded inside
  `String#replace`. Same error texts and same order of failed rules. A step expression answers a
  compilable aggregate from the SQL batch (as a derived field does) instead of walking child rows.
  Only render, perms and field hooks (S3c) still use the lazy `RowCtx`. The old lazy contexts stay
  behind the test-only `store.lazyEval`.
- Gates: `tests/snapshot.test.mjs` (no driver call while a rule or a step value is evaluated; the
  loads sit inside the transaction; no load inside `String#replace`; one context per write),
  `tests/evaldiff.test.mjs` (generated writes over every app's rules and every declared step value, through
  both paths: same outcomes, error texts and stored rows); `S3b:` mutations.
- This also removes the reference-hop N+1: a list page whose derived fields read `customer.name`
  or `order.customer.discount` used to issue one query per hop per row; it now issues a constant
  number (`tests/perf.test.mjs`). Answers are byte-identical: the JSON and CSV of the benchmark
  routes (and of both benchmark graphs' routes, HTML and JSON) match 0.2.0.
- The old lazy hydration moved to `runtime/store/lazy.mjs` and stays one release behind the
  test-only switch `store.lazyEval`.
- Gates: `tests/snapshot.test.mjs` (every row of every app under `apps/` hydrated through both paths
  with identical JSON; no driver call while evaluate runs over list, detail, CSV and dashboard;
  `not loaded` throws), `tests/plan.test.mjs`, the hop gate in `tests/perf.test.mjs`, the snapshot
  vs lazy comparison in `tests/aggfuzz.test.mjs`; `S3a:` mutations.
- **Fixes: the layering gate checked nothing.** `tests/arch.test.mjs` parsed import specifiers from the
  masked text, where string literals are blanked, so no `from '...'` ever matched and an illegal import
  passed. The parser now finds statements on the masked text and reads the specifier from the original
  source at the same offset (multi-line, `export ... from`, bare and literal dynamic `import`); a self-test
  covers it, including imports inside strings and comments. All 166 real edges match the allow-list.
- **Fixes: acceptance no longer depends on the wall clock.** `domains` and `promos` failed from 2026-10-01
  (seed expiry dates that a "must be in the future" rule rejects at boot; literal 2027 dates in `domains` checks).
  Seeds that need a future date now use 2099, checks derive their dates from `Date.now()`. New guard:
  `verify/shift.mjs` (preload, `SHIFT_DAYS`) and `node verify/run.mjs --dated` (apps that read `today`/`days(`/`addDays`),
  run by CI with the clock ten years ahead.

## 0.3.0 (2026-09-29)

Two roadmap items move: the connector library starts (stage C1 of `docs/CONNECTORS.md`: a
connector is a validated JSON descriptor, `http` runs on it) and PostgreSQL reaches stage S2 (the
store builds all SQL through a dialect; a `postgres` dialect exists and is golden-tested, still
without a driver). No answer changes: JSON/CSV of the benchmark routes are byte-identical to 0.2.0,
and existing `http` connectors deliver byte-identical requests.

### Connector library

- **Connector descriptors (connector library, stage C1).** A connector is now data: a
  descriptor (`docs/CONNECTORS.md`) names the operations of a service, the JSON-Schema-subset
  input and output of each, the request template and how to map the answer. New `runtime/connectors/`:
  `schema.mjs` and `template.mjs` (pure leaves; an unknown schema keyword is an error, templates
  have no expressions or conditionals), `descriptor.mjs` (validates a descriptor, fail closed),
  `engine.mjs` (request building, response mapping, output validation, and the registry transport
  a descriptor becomes), `builtin.mjs` (built-in descriptors as JS literals). A `.json` file in
  `plugins` registers a descriptor as a connector kind of its own name. One new block,
  `connector.call { connector, op, input, ref? }`, validates `input` against the operation's schema
  when the step runs, inside the transaction, so a malformed call refuses the action and never
  reaches the outbox; the checker validates literal inputs and `@row.field` types against the
  same schema. `http` is now a built-in descriptor and delivers byte for byte what it did (same
  url, method, JSON body, header merge and 3000 ms timeout; `http.send` and `connector.send` rows
  are queued without an operation and delivered as its `send`). `mail` is unchanged. The checker
  refuses a literal secret in a connector (by key name or by shape) and a secret or credential
  in a url; `{secret.*}` is reference syntax only until the secret store lands (C2): a delivery
  that needs one fails closed with a clear message. `_outbox` gains `op`, `response` (capped at
  16 KB), `result` and `drift`, added in place like `claimedAt`; an answer that does not fit the
  operation's `output` schema sets `drift=1` and traces `contract_drift` while the row stays
  `sent`. URL safety: `{input.*}`/`{key}` in a url template are percent-encoded, an input in the origin is a descriptor error, header values with a line break fail the delivery. Gates: five `tests/connectors_*.test.mjs` files (the http regression compares against a
  copy of the old transport), 48 `C1:` mutations, the new modules in the layer table.

### PostgreSQL

- **Portable SQL and dialect hooks (PostgreSQL roadmap, stage S2).** New
  `runtime/driver/dialects.mjs` (a pure leaf): a `sqlite` and a `postgres` dialect with every
  hook the store builders need: placeholders (`?` / `$n`), `quote`, id and integer column types
  (`BIGINT` identity on pg), insert-returning, `LOWER(..) LIKE .. ESCAPE`, date buckets,
  NULL order and collation, boolean-to-int wrappers, upsert, schema introspection SQL and index
  names. `query.mjs`, `aggsql.mjs`, `aggexpr.mjs`, `state.mjs`, `migrate.mjs` and `store.mjs`
  build their SQL through `drv.dialect`; the SQLite driver takes its DDL and catalog queries
  from it too. SQLite is still the only executor and behaves byte-identically: `IFNULL` is
  `COALESCE`, every identifier of `_outbox`/`_session` is quoted (`user` is reserved on pg,
  `updatedAt` folds on pg), booleans in compiled aggregates are `CASE .. THEN 1 ELSE 0` (no
  engine boolean type). Nothing about ordering changed in SQLite; the `id` tie-break, `NULLS
  FIRST/LAST` and `COLLATE "C"` exist in the postgres dialect only. SQLite keeps `strftime` for
  date buckets (a `time` field accepts any text `Date` parses, which `SUBSTR` would not
  normalise the same way); pg uses `SUBSTR`. SQLite index names are exactly today's; pg
  names over 63 bytes are cut on a character boundary and end in an 8-digit hash, so a
  restart finds the index it created.
- Gates: `tests/dialect.test.mjs` (golden SQL for every builder shape per dialect, in
  `tests/golden/`, pg text generated with no server and checked for `$n` numbering), an arch
  gate "runtime/store** names no SQLite-only keyword", 27 mutations `S2:` and re-pointed old
  ones.

## 0.2.0 (2026-09-29)

Two roadmap items move: horizontal scaling (the outbox is safe under overlapping deliveries) and
PostgreSQL (step 1, stage S1 of the accepted design in `docs/POSTGRES.md`: the store talks to a
driver, not to SQLite). Plus one fix to expression arithmetic. No answer changes except the money
fix below; JSON/CSV of the benchmark routes are byte-identical to 0.1.3.

### Horizontal scaling: outbox delivery

- **The outbox delivers each row once.** `flush` used to read every `queued` row, deliver them
  one by one and only then update them, so two overlapping flushes (two requests committing
  close together; later several instances) both delivered the same row. A row is now claimed by
  one atomic `UPDATE ... WHERE status='queued'` (`Store#outboxClaim`) and only the caller whose
  update changed the row delivers it: `queued → sending → sent|failed`.
- **Lease recovery.** A row stuck in `sending` for more than 60 s (the process died
  mid-delivery) is claimed again. Delivery is therefore exactly-once, and at-least-once across
  a crash; connectors should send an idempotency key.
- **A late result cannot overwrite a re-claim.** The final write of a flush's delivery is
  conditional on still holding its claim (`Store#outboxFinish`: `WHERE id=? AND claimedAt=?
  AND status='sending'`). If the lease ran out and another flush took the row, the slow
  first delivery is dropped and traced (`kind:'delivery', stale:true`), not an error.
- New column `_outbox.claimedAt`, added in place to databases made by earlier versions.
- Tests: concurrent flushes, lease before/after, in-place upgrade from the old DDL; six new
  mutations.

### PostgreSQL: the Driver seam

- **The Driver seam (PostgreSQL roadmap, step 1, stage S1).** The store no longer holds a
  SQLite handle: it talks to a `Driver` (`runtime/driver/sqlite.mjs`, opened by
  `runtime/driver.mjs`) through `this.drv`: `all/get/run/exec/transaction/close`, a `dialect`,
  schema helpers (`tables/columns/indexes/createTable/addColumn/createIndex/dropIndex`) and an
  `onQuery` hook. The prepared-statement LRU moved into the driver; `PRAGMA`, `sqlite_master`
  and `AUTOINCREMENT` no longer appear outside it. `new Store(graph, file, registry, driver)`
  accepts a driver. Still synchronous; no answer, schema, migration message or trace changes.
  `Store#prepare` and `store.db` are gone.
- Gates: `node:sqlite` only in `runtime/driver/sqlite.mjs`; new arch gate keeping SQLite-only
  surface under `runtime/driver/`. Query counting in `perf.test.mjs` uses the driver hook.
  Mutations re-pointed, ten new. `docs/POSTGRES.draft.md` is now `docs/POSTGRES.md` (design
  accepted, status per stage).

### Fixes and hygiene

- **Fix: money arithmetic in expressions is exact.** `runtime/expr.mjs` evaluated money as
  doubles in major units, so `qty * price` with 3 and 0.1 was 0.30000000000000004 and
  `qty * price > 0.3` was true in the JS path while the SQL path (exact integers in minor
  units) said false. Every `*` now goes through the same `exact()` (6 decimals) that `+`,
  `-`, `sum` and `avg` already used, so JS, SQL and decimal arithmetic agree. Division is
  unchanged (a quotient is a fraction; it stays JS-only). This changes an answer in edge
  cases: ties like the one above, and values with more than 6 decimals, now come out
  rounded. A nested `min`/`max` over a raw money product now compiles to SQL; a product of
  more than 6 decimals (four money factors) is left to the JS path.
- **Tests no longer leak temp directories.** Every test directory goes through `tmpDir` and is removed on exit; the coverage gate fails if the suite leaves anything in a private `TMPDIR`, and each mutation run gets (and loses) its own.

Tests 267 (0.1.2) → 280 (0.1.3) → 295, mutations 164 → 179, all killed; 699 acceptance checks pass.

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
