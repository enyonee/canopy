# Canopy connector library: design (v0.2.0 baseline)

**Status: design accepted (maintainer decisions, section 9), and built: stages C1, C3, C2, C4, C5, C6 and C7 are done. The connector-library
design is complete.** (C1: descriptor, checker, engine, `connector.call`, `http` on it; C3: retries with backoff, `unknown`,
timeouts, circuit breaker, background flusher, injectable clock; C2: encrypted secret store, sandbox and live mode; C4:
inbound webhooks, signed and deduplicated; C5: the first real providers, Stripe, Postmark and Slack, as descriptors with
hand-written fixtures; C6: the OpenAPI import, a draft descriptor from a JSON spec with everything it could not map
listed; C7: the settings screen, `/settings`; see "C1 as built" to "C7 as built" at the end.)

The study below was read-only. All line numbers refer to /home/vyacheslav/code/canopy at main, before C1.

## 1. Inventory of today's effect path

**Path.** A step calls a block: `http.send` blocks.mjs:132-140, `connector.send` :141-148, `mail.send` :149-158, plugin `sms.send` (plugins/messaging.mjs:18-33), `payment.charge` (plugins/payment.mjs:25-39). `runSteps` (interp.mjs:110) runs it inside the caller's transaction. The block calls `store.enqueue({kind, connector, target, payload})` (store/state.mjs:5-9), which inserts an `_outbox` row with status `queued`, attempts 0. After COMMIT, `withEffects` (interp.mjs:87-91) calls `flush` (outbox.mjs:37-45). `flush` reads `outboxDue`, then does an atomic `outboxClaim` (state.mjs:25-29): `queued` or `sending` with an expired lease, LEASE_MS=60000 (outbox.mjs:32). `deliver` (outbox.mjs:7-27) looks up `registry.transports[row.kind]` and calls `transport.deliver(row, connectorCfg, {fetchImpl})`. The returned patch `{status, code, error}` is written by `outboxFinish` (guarded by claimedAt, state.mjs:41). If the lease was lost, the result is dropped as `stale`. Exceptions become `failed`. The trace gets `{kind:'delivery', id, via, connector, target, status, code}`. `/outbox` (routes/system.mjs:12-25) lists rows and has a "Retry" that resets to `queued` and flushes (:18-19). Access is `vc.outbox`, i.e. an admin (context.mjs:97).

**Gaps that shape the design.**
- No retry, no backoff and no `nextAttemptAt`. `failed` is terminal until a human presses Retry.
- No idempotency key is sent (docs/FORMAT.md:202-203 only recommends one).
- No response body is kept, so nothing flows back to the graph.
- No circuit breaker and no clock injection (`flush` has `now`, `deliver` uses `new Date()`, state.mjs:6,34).
- Timeout is 3000 ms, hard-coded (transports.mjs:5) and overridable by `connector.timeout`.
- The tests' `fakeFetch` (tests/helpers.mjs:22-31) returns `{ok,status}` with no `.text()`. The engine must tolerate a body-less response for the legacy kinds.

**Connector config shape.** `graph.connectors[name] = {kind, ...}` (FORMAT.md:284-304). `check/connectors.mjs:5-14` looks up `registry.transports[kind]` and asks `transport.validate(c)` for `[key, msg, hint]`. Transports are built in (`http`, `mail`, transports.mjs:9-33) or come from a plugin (`register`, registry.mjs:22-35; an existing name is an error). The step checker (check/steps.mjs:35-39) requires `block.connector === c.kind` when the block declares one. `TransportType` is in types.d.ts:144-148.

**Sandboxes today.**
- `payment` (plugins/payment.mjs): a pure Luhn check plus the magic PAN 4000000000000002 run *inside the transaction*, so a decline rolls back the action (:31-33). The authorization id uses `Date.now()` (:34). The capture is a no-op delivery returning `sent/200` (:21).
- `mail`, `sms`, `whatsapp`: `deliver` returns `sent` without doing anything (transports.mjs:30-32, messaging.mjs:12).
- `http` is the only live transport. The four apps that use it are hard-wired to the verify sink 127.0.0.1:8999 (verify/lib.mjs:58-77; AGENTS.md notes this).
- There is no notion of a mode. Everything except `http` is permanently a sandbox.

**Inbound.** There is none. No route accepts a provider call. `dispatch` (server.mjs:38-46) is widgets, then session, then the "Please sign in." gate, then views, system, schedule and entity. Bodies are parsed as multipart or urlencoded only (context.mjs:20-40), so there is no raw body for HMAC and no JSON parse. `POST /action/<name>` is a signed-in user's action, not a webhook.

**Apps using connectors** (from `apps/*/app.json`, 104 apps total):
- 23 apps declare `connectors`: 25 connectors in all (20 mail, 4 http, 1 sms).
- mail: 20 (camping, cars, coaching, consulting, crm, domains, and others).
- http: 4 (barber:whatsapp, crm:crmHook, shop:fulfilment, startups:shareHook), all to :8999.
- sms: 1 (animalspotter:alerts).
- `kind:"payment"`: 0 apps. Only `tests/` exercises `plugins/payment.mjs`.
- `http.send` is used 5 times, `mail.send` 38 times and `sms.send` once in blocks. `connector.send` and `payment.charge` are used 0 times in apps.
- Migration budget: any change must keep the 4 http apps' sink checks and 20 mail apps byte-identical.

## 2. The contract

### 2.1 Where a descriptor lives
A **JSON file** `connectors/<name>/descriptor.json` at the repo root. It is *not* in `plugins/`, because the registry-contract test imports everything under `plugins/` as server code (FORMAT.md:352). Beside it sit `fixtures/*.json` (recordings) and `sandbox` rules inside the descriptor. Data, not code, so that an OpenAPI import (C6) can emit it and the checker can reason about it without running anything.

An app lists it the way it already lists shared plugins: `"plugins": ["../../connectors/stripe/descriptor.json"]`. `loadPlugins` (registry.mjs:43-62) learns `.json` entries: it validates the descriptor and registers it. Registration synthesizes a **transport** named by the descriptor (`kind: "stripe"`), so `check/connectors.mjs`, `outbox.deliver` and the blocks stay on the existing path. It also adds a sixth registry table, `descriptors` (a change to `TABLES` at registry.mjs:14 and `createRegistry` :17).

```json
{
  "descriptor": 1, "name": "stripe", "title": "Stripe", "version": "2024-06-20",
  "modes": ["sandbox", "live"],
  "config": { "properties": { "currency": {"type":"string","pattern":"^[A-Z]{3}$"} }, "required": [] },
  "auth": { "slots": { "apiKey": { "secret": true, "sandboxDefault": "sk_test_sandbox" } },
            "apply": { "header": "authorization", "value": "Bearer {secret.apiKey}" } },
  "base": { "sandbox": "canopy:sandbox", "live": "https://api.stripe.com" },
  "timeoutMs": 10000,
  "retry": { "max": 5, "baseMs": 1000, "capMs": 300000, "on": ["timeout","network",429,"5xx"] },
  "breaker": { "failures": 5, "cooldownMs": 30000, "maxCooldownMs": 300000 },
  "operations": {
    "createPaymentIntent": {
      "idempotent": true,
      "idempotency": { "header": "Idempotency-Key" },
      "input":  { "type":"object", "required":["amount","currency"], "additionalProperties": false,
                  "properties": { "amount":{"type":"integer","minimum":1}, "currency":{"type":"string","pattern":"^[A-Z]{3}$"},
                                  "orderRef":{"type":"string","maxLength":64} } },
      "request": { "method":"POST", "url":"{base}/v1/payment_intents", "encoding":"form",
                  "body": { "amount":{"$":"input.amount"}, "currency":{"$":"input.currency"}, "metadata[order]":{"$":"input.orderRef"} } },
      "output": { "type":"object", "required":["id","status"], "properties": { "id":{"type":"string"}, "status":{"type":"string"},
                  "client_secret":{"type":"string"} } },
      "result": { "id":"$.id", "status":"$.status" },
      "outcomes": { "sent": "$.status", "failed": "4xx" }
    }
  },
  "inbound": {
    "signature": { "scheme":"stripe", "header":"stripe-signature", "secret":"webhookSecret", "toleranceS":300 },
    "eventId": "$.id",
    "events": {
      "payment.succeeded": { "match": {"$.type":"payment_intent.succeeded"},
        "schema": { "type":"object", "required":["data"] },
        "map": { "ref":"$.data.object.metadata.order", "amount":"$.data.object.amount" } }
    }
  },
  "sandbox": { "operations": { "createPaymentIntent": [
      { "when": {"input.amount": {"gt": 99999900}}, "status": 402, "body": {"error":{"code":"amount_too_large"}} },
      { "status": 200, "body": {"id":"pi_sbx_{key}","status":"requires_payment_method","client_secret":"sbx_secret_{key}"} } ] } }
}
```

Rules of the language (each is a checker rule):
- **Schema** is a JSON-Schema subset: `type`, `properties`, `required`, `items`, `enum`, `minimum/maximum`, `minLength/maxLength`, `pattern`, `format` in {`email`,`date-time`,`uri`}. It is implemented in a leaf `runtime/connectors/schema.mjs`. An unknown keyword in a descriptor is a descriptor error (fail closed), and `additionalProperties` defaults to `false` for inputs.
- **Templates** are `{config.x}`, `{input.x}`, `{secret.x}`, `{base}` and `{key}` (the idempotency key), plus the whole-value form `{"$":"input.x"}`. No conditionals and no expressions. The `url` template may use `{base}`, `{config.*}` and `{input.*}` but **not** `{secret.*}` (the URL becomes `row.target`, which the outbox screen and the trace show).
- `outcomes` maps a response to the event names `sent` or `failed`. `result` picks output fields by JSON path (`$.a.b[0]`).

### 2.2 How an app calls it
A new generic block in the catalog (`connector.call` in blocks.mjs, `effects:['out']`, `requires:['connector','op','input']`):
```json
{ "block":"connector.call", "connector":"pay", "op":"createPaymentIntent",
  "input":{ "amount":"= total * 100", "currency":"USD", "orderRef":"@row.id" },
  "ref":"@row" }
```
- The graph gets `"connectors": { "pay": { "kind":"stripe", "secrets": { "apiKey":"stripe_key", "webhookSecret":"stripe_whsec" } } }`. `secrets` maps the descriptor's slots to **names** in the store. It never holds a value.
- `run()` resolves `input` (the existing `resolve`, interp.mjs:113), validates it against `descriptor.operations[op].input` **at enqueue time, inside the transaction**, and throws on any problem. A bad call therefore refuses the whole action (rollback, 400), and a malformed request never reaches the outbox. It enqueues with new columns: `op`, `mode`, `idemKey`, `refEntity`, `refId`. It returns `{delivery}` as the other blocks do (a step in `steps.mjs:41` also needs `'input'` added to the values-checked keys).
- The legacy blocks stay as sugar: `http.send`, `mail.send`, `sms.send` and `connector.send` enqueue with `op` set, so nothing in the 23 apps changes.
- **Inbound as a graph event.** `{ "on":"inbound:pay.payment.succeeded", "do":[ { "block":"db.set", "entity":"Order", "id":"@event.ref", "set":{"paid":1} } ] }`. The checker (events.mjs:54-68) gains two prefixes, `inbound:<connector>.<event>` and `connector:<name>.<op>.<sent|failed>`. Both are checked against the registered descriptor.

### 2.3 Outputs back into the graph without breaking the invariant
The invariant holds because the network call stays an outbox delivery node and everything after it is again a graph event with steps:
1. `deliver` stores the result on the row: new columns `response` (JSON, redacted, size-capped at 16 KB), `result` (the mapped output fields), `drift` (0/1).
2. After `outboxFinish` succeeds, `deliver` calls an injected `opts.onSettled(row, patch)`. `interp.mjs` supplies it, since it already imports `outbox.mjs`. It runs a **new transaction** that fires `connector:<name>.<op>.<sent|failed>` events.
3. If `ref` was given, the event runs with `rowEntity/id` = that row, so ordinary `db.update`/`db.set` steps work. Extra names are `@delivery.{id,status,code,error}`, `@result.<field>` and `@input.<field>`.
4. To make this at-least-once safe, a `settledAt` column is claimed with `UPDATE ... WHERE settledAt IS NULL` before the event fires. A crash between the finish and the event is repaired by the flusher, which re-fires events for rows that are `sent`/`failed` and unsettled.
5. Computation stays pure: schema validation, template expansion, path picking, signature verification, the backoff formula and the breaker step are all functions with no I/O, in leaf modules.

Limitation to record: an operation whose answer is needed *inside* the action (today's `payment.charge` authorisation) cannot be a live call. In live mode the flow is a two-phase `createPaymentIntent`, then an event or an inbound `payment.succeeded` that sets `Order.paid`. The sandbox `payment` kind keeps its pure in-tx authorisation as a legacy block.

### 2.4 Checker rules (`check/connectors.mjs` grows, or is split at 300 lines)
Every rule fails closed and names a JSON path and a hint:
- The descriptor itself is validated at load: allowed keys, valid schemas, templates reference only known scopes, no `{secret.*}` in `url`, every op has `idempotent` set explicitly (no default), `timeoutMs ≤ LEASE_MS/2`, and `retry.max ≥ 1` only when `idempotent` or an `idempotency` mechanism exists.
- Connector config validates against `descriptor.config`. Every `auth.slots` entry marked `secret` must be mapped in `secrets`. **No literal secrets:** any string value under a key matching `/key|token|secret|password|authorization/i`, or looking like `sk_…`/`Bearer …`/JWT, is an error ("put it in the secret store; app.json names it").
- `connector.call`: the connector exists and its kind has a descriptor; the op exists; `input` keys ⊆ schema properties; required keys present; **literal** values are validated against the schema; a `@row.f` reference is validated by mapping the field kind (`money`→number, `text`→string, `ref`→integer, `bool`→boolean) to the schema type; `ref` names a known entity.
- Events: `inbound:`/`connector:` prefixes are resolved against the descriptor; steps inside get `@event`/`@result` names with known keys (`ctxIn` in steps.mjs:11-14).
- Runtime re-validation is the backstop (2.2). Responses are validated against `output` (drift, section 6).

## 3. Secrets
- **Where.** `<dir>/secrets.enc` next to `data.sqlite`, following the `session.key` precedent (auth.mjs:25-29). The master key is `CANOPY_MASTER_KEY` (32 bytes, base64) when set, else a generated `<dir>/secrets.key` (mode 0600). For a hosted deployment, env-only is the recommended setting: a key file beside the ciphertext protects only against a leak of one file. Both new files go into `.gitignore` and AGENTS.md's "never commit" list.
- **Format.** Module `runtime/secrets.mjs` (node:crypto, node:fs; added to the `NODE_BUILTINS` table in tests/arch.test.mjs). The whole blob is encrypted, so secret *names* are hidden too: `{v:1, alg:"aes-256-gcm", salt, nonce, tag, ct}`. The key is `crypto.hkdfSync('sha256', master, salt, 'canopy-secrets-v1', 32)`. AAD is `app` + `v`. Writes are atomic (temp file plus rename) and bump a counter. A wrong key or a tampered tag throws (fail closed). Rotation is `--secrets rekey`.
- **Naming.** The graph holds only names (`"secrets":{"apiKey":"stripe_key"}`), and the checker knows names but not values. `deliver` gets `opts.secret(name)`, which reads the decrypted map cached in memory and returns a value only for the duration of one request. A `redact(text, secretValues)` leaf masks every known secret value in errors, `response`, trace fields and the JSON of any route.
- **Never leaks.** Outbox `payload` holds only the *input* (never auth). The auth header is built inside `deliver` and never stored. The URL template forbids secrets (2.1). Descriptors may not declare `sensitive` inputs before a decision (see section 8), and a PAN-like value in an input is refused ("use a provider token").
- **CLI.** Extend `runtime/cli.mjs` (the layer-10 entry) with `--connectors <status|secret-set NAME|secret-rm NAME|secret-list|live NAME|sandbox NAME|rekey>`. A secret's value is read from stdin or `CANOPY_SECRET_VALUE`, never from argv (shell history). `secret-list` prints names only, never values.
- **Mode (as built: section 12).** The mode is *not* in app.json (the same graph runs in dev and prod). It lives in the plain, diffable `<dir>/deploy.json`: `{connectors:{pay:{mode:"live", since, by}}}`. The default is `sandbox`. `live NAME` requires all `secret` slots to be present, `--confirm NAME`, and every live `base` to be https. It appends a row to a `_deploy_log` table. At boot and on each flush (stat mtime), a connector in live with a missing secret is marked *misconfigured*: deliveries fail with a clear error and **never fall back to sandbox silently**. The outbox row records `mode`, and `/outbox` shows it.
- **Built-ins.** `http` and `mail` declare `modes:["live"]` and `["sandbox"]` respectively, so the four sink apps and the 20 mail apps keep today's behaviour with no deploy step (decide now, section 8).

## 4. Reliability

**Schema additions to `_outbox`** (added like `claimedAt`, store/migrate.mjs:72-73; quote all columns, see docs/POSTGRES.md:184): `op`, `mode`, `idemKey`, `nextAttemptAt` (INTEGER epoch ms), `response`, `result`, `drift`, `settledAt`, `refEntity`, `refId`.

**Idempotency key.** `idemKey = base32(sha256(app + "|" + connector + "|" + row.id + "|" + row.at))[:32]`, computed once at enqueue and stored. The same key is reused on every retry and after a lease expiry (this is what makes the at-least-once path of outbox.mjs:29-31 safe). It is sent as the descriptor's `idempotency.header`, or as a body field. Including `row.at` protects against row-id reuse after a database restore.

**Retry policy** (`runtime/connectors/backoff.mjs`, a pure leaf):
- Classify each outcome: `network|timeout|429|5xx` is retryable, other 4xx is permanent, 2xx is sent.
- Retry only if the op is `idempotent:true` or has an `idempotency` mechanism. A non-idempotent op that times out ends as a new status `unknown` (the request may have landed) and needs an operator decision in `/outbox`. A definite failure before the request left (DNS, connection refused) may still retry.
- Delay = `min(capMs, baseMs·2^(attempts−1))`, with jitter derived deterministically from `hash(idemKey, attempts)` (no `Math.random`, so it is testable), raised to `Retry-After` when present (capped by `capMs`).
- A retry writes `status='queued', nextAttemptAt=now+delay` (attempts already counts, outbox.mjs:9). `outboxDue` (state.mjs:18-21) gains `AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=?)`. After `max` attempts the row ends `failed`. The manual Retry (system.mjs:18) clears `nextAttemptAt` and resets attempts.
- **Timer.** A new `startFlusher` next to `startTimers` (server.mjs:53-64): a `setInterval` (default 5 s) that calls `flush`, plus a one-shot `setTimeout` to the earliest `nextAttemptAt` (query `outboxNextDue`). It is `unref`'d, stopped on `server.close`, and off under `noTimers` (AG_NO_TIMERS, cli.mjs:35), so verify and the tests stay deterministic. It also re-fires unsettled events (2.3).

**Timeout.** It comes from the descriptor (`timeoutMs`), overridable per connector, capped at `LEASE_MS/2`. This keeps a slow provider from outliving its lease and causing a double delivery.

**Circuit breaker.** A per-connector, per-mode row in `_breaker(connector, mode, state, failures, openUntil, probeClaimedAt)`, persisted (it survives restarts and is shared across instances on pg). Pure `breakerStep(state, event, now, cfg)` gives closed → open (after N consecutive retryable failures) → half-open after `openUntil`, where **one** probe is claimed atomically. A success closes it, a probe failure reopens it with the cooldown doubled up to `maxCooldownMs`. While open, `flush` does not claim that connector's rows and pushes their `nextAttemptAt` to `openUntil` **without incrementing attempts**. 4xx never trips it. The state shows in `/outbox` (and in section 7's C7 screen).

**Testability.** One clock object `{now(), setTimer(fn,ms)→handle, clear(handle)}` is injected through `serve({clock})`, `flush(opts.now)`, `deliver(opts.now)` and `startFlusher`. The tests' fake clock has `advance(ms)`, which fires the due timers. Timeouts use `opts.timeoutSignal(ms)` (default `AbortSignal.timeout`); the tests inject a controllable AbortController. Together with `fetchImpl` this makes every backoff, breaker and lease scenario deterministic. `Date.now()` is banned from the new modules by a new source-scan test in tests/arch.test.mjs (like the console.* one).

## 5. Inbound webhooks
- **Route.** `POST /hook/<connector>` in a new `runtime/routes/hooks.mjs`, dispatched **before** the session gate (server.mjs:39-41, next to `widgets.handle`). It needs a **raw** body, so `context.mjs` gains `rawBody(req, cap=1 MiB)` (throws `TooBig`, already handled at server.mjs:102). It has no session, no user and no cookie, and ignores `accept: text/html`. It answers JSON only, and echoes nothing from the payload.
- **Steps.**
  1. Resolve the connector, its descriptor's `inbound` block and its mode. Unknown or no inbound → 404.
  2. Verify the signature (`runtime/connectors/signature.mjs`, `node:crypto`, `timingSafeEqual` after a length check, as in auth.mjs:18,36). Bad → 401, and trace `webhook_rejected` with the reason (never the body).
  3. Replay window: for schemes with a timestamp, `|clock.now() − t| ≤ toleranceS` (default 300 s) → else 401.
  4. Parse the JSON, then validate it against the matched event's `schema` (fail closed → 400; **no** dedup row is written).
  5. Compute `eventId` (`$.id` or a header).
  6. Open **one** transaction. `INSERT INTO _inbound(connector, eventId, receivedAt)` has `UNIQUE(connector,eventId)`. If a duplicate, roll back and answer `200 {duplicate:true}` (a provider retries anything non-2xx, so a duplicate must be 2xx). Otherwise run the mapped graph event's steps in the same transaction, then commit. A crash before commit leaves no dedup row, so the provider's retry is processed exactly once.
  7. Unknown event types → `200 {ignored:true}` plus a trace (providers send many types). Failing steps → 500 (so the provider retries), traced.
- **Signature variants** (descriptor `inbound.signature`, implemented as named recipes plus a generic one):
  - `stripe`: header `t=<unix>,v1=<hex>[,v1=…]`, signed `t + "." + raw`, HMAC-SHA256 hex, accepts any of several `v1`.
  - `slack`: `v0=` + HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw>`, tolerance 300 s.
  - `hmac`: generic `{header, algo:"sha256|sha1", encoding:"hex|base64", prefix, signed:"raw|ts.raw", timestampHeader?}`.
  - `basic`: HTTP Basic credentials from the store (Postmark).
  - Each `secret` is a *list* in the store (`whsec` and `whsec.prev`) to allow rotation.
- **Dedup retention.** `_inbound` rows are pruned by the flusher after 30 days (must exceed the provider's longest retry window).
- **Sandbox.** There is no fixed dev secret. `--connectors simulate NAME EVENT --data f.json` signs a payload with the stored secret and POSTs it to the local `/hook`. verify and the settings screen use the same path.

## 6. Hermetic tests
- **Recording fixture** `connectors/<name>/fixtures/<op>.<case>.json`:
  `{"op","case","recordedAt","providerVersion","request":{"method","url","headers":{"authorization":"«redacted»"},"body"},"response":{"status","headers","body"}}`.
  `replayFetch(fixtures)` (a `fetchImpl`) matches on method + URL + canonical body and **throws on a miss** (fail closed, no network, no fall-through). It must return a body-carrying response (`text()`), unlike `fakeFetch`.
- **Recorder** `--connectors record NAME OP` runs only by hand with real test-mode keys (never in CI). It scrubs every known secret value and the configured header names, and refuses to write if any string still looks like `sk_`, `Bearer `, a JWT or a long high-entropy token. A unit test scans all fixtures for the same patterns.
- **Fake provider = descriptor `sandbox` block**, run by a pure engine `connectors/sandbox.mjs`: ordered `when` rules on `input.*`, the response body templated with `{key}`. Contract tests per descriptor: (a) every op's sandbox responses validate against its `output` schema; (b) each recorded response has the same *shape* (keys and types, not values) as the sandbox's success response; (c) the request built for each fixture's input equals the recorded request after redaction.
- **Drift.** Offline (in the gate): fixtures and sandbox outputs are validated against the schemas, so a descriptor edit that breaks a recording fails. Runtime: a response that fails `output` validation sets `drift=1` and traces `contract_drift {connector, op, path}`. The effect already happened, so the row stays `sent` (strict mode is per-connector opt-in). A manual or nightly job `--connectors drift NAME` (test-mode credentials, outside the gate) replays the sandbox cases against the real provider and diffs response *shapes* against the last recording.
- **Inbound fixtures.** Signed payloads (with a fixed test secret and the injected clock) per event cover accept, bad signature, stale timestamp, duplicate, unknown type and a failing step.

## 7. Staged PRs
Each PR keeps `npm run gate` and `node verify/run.mjs` green. Module ≤300 lines and function ≤60 lines (tests/arch.test.mjs). Every new module goes into `ALLOWED` at the named layer; new `node:` use goes into `NODE_BUILTINS`. Update `docs/FORMAT.md` and `runtime/ARCHITECTURE.md` in each. Mutations are added to `tests/mutate.mjs` (179 today) and must not delete existing ones.

**C1: descriptor + checker + `http` on it (about +600 lines).**
- New leaves (layer 0): `runtime/connectors/schema.mjs`, `template.mjs`, `descriptor.mjs` (validates a descriptor).
- New layer 2: `runtime/connectors/engine.mjs` (request build, response map, output validation).
- Changed: `registry.mjs` (`descriptors` table, `.json` entries in `loadPlugins`), `transports.mjs` (`http` becomes a built-in descriptor object `runtime/connectors/builtin.mjs`, JS-literal so `DEFAULT` stays synchronous and file-free), `blocks.mjs` (`connector.call`), `check/connectors.mjs` and `check/steps.mjs` (input validation, literal-secret rule), `types.d.ts`, migrate (`op`, `response`, `result`, `drift`).
- Non-regression: the existing http request is byte-identical (method, JSON body, header merge, the 3000 ms timeout, target = url + path), and the `outbox.test.mjs` cases pass unchanged.
- Tests: `tests/connectors_schema.test.mjs`, `_descriptor`, `_engine`, checker fixtures for every rule, and a property test that any schema-valid input produces a request the engine can build.
- Mutations: unknown descriptor keyword accepted, required check off, `additionalProperties` default flipped, `{secret.*}` allowed in url, literal input not validated, output validation skipped.

**C2: secrets store + mode (about +350).**
- New: `runtime/secrets.mjs` (layer 0, node:crypto+fs), `runtime/deploy.mjs` (mode file plus `_deploy_log`, layer 4), CLI subcommands, `redact` in `template.mjs`.
- `deliver` gets `opts.secret/mode`. `.gitignore` and AGENTS.md updated.
- Tests: encrypt/decrypt round-trip, wrong key, tampered tag, atomic write, redaction in trace/response/error, `live` refused with a missing secret, no silent sandbox fallback.
- Mutations: no tag verification, mode defaults to live, redaction removed, argv secret accepted, `live` without `--confirm`.

**C3: retries, backoff, breaker, clock (about +450).**
- New leaf `runtime/connectors/backoff.mjs` (policy + `breakerStep`). New tables `_breaker`. Columns `nextAttemptAt`, `idemKey`, `settledAt`. `outbox.mjs` split into `outbox.mjs` + `settle.mjs` to stay under 300 lines. `startFlusher` in `server.mjs`. `serve({clock})`. The Retry route clears the schedule.
- Tests: table-driven backoff, deterministic jitter, `Retry-After`, non-idempotent → `unknown`, half-open single probe (property test over event sequences), lease vs timeout, a fake-clock server test of a full outage-recovery cycle. `tests/outbox.test.mjs` extended.
- Mutations: retry on a non-idempotent op, backoff not capped, breaker never opens/closes, probe claim not atomic, attempts incremented while the breaker is open, key regenerated per attempt.

**C4: inbound webhooks (about +450).**
- New: `runtime/connectors/signature.mjs` (layer 0, node:crypto), `runtime/routes/hooks.mjs` (layer 8), `_inbound` table, `rawBody` in `context.mjs`, `inbound:` events in `check/events.mjs`, `--connectors simulate`.
- The `/hook` route dispatches before the session gate. This is a new unauthenticated surface: it needs a security review.
- Tests: the accept/reject matrix in section 6, a length mismatch not throwing in `timingSafeEqual`, dedup exactly-once across a simulated crash, the 1 MiB cap, and no echo of the payload.
- Mutations: compare with `===` instead of constant time, no replay window, dedup row written before the steps' commit, the signature check skippable when the header is absent, unknown type → 500.

**C5: first real providers (about +300 each, descriptors + fixtures only).** All are `sandbox` by default and tested with recordings only; no network in CI.
1. **Stripe** (payments: PaymentIntents, refunds, signed webhooks). The highest demand in the README; covers the form encoding, the `stripe` signature and native idempotency keys.
2. **Postmark** (email: a JSON API, the `X-Postmark-Server-Token` header, bounce/unsubscribe webhooks on `basic` auth). It is the simplest real replacement for the 20 mail connectors (38 `mail.send` uses) in 20 apps, and it needs no request signing (unlike SES SigV4).
3. **Slack** (messaging: `chat.postMessage` with a Bearer token, Events API with the `slack` v0 signature). It covers the third signature family and a third auth style with the least setup, so it is the cheapest way to prove inbound end to end.
- Twilio (form body, HMAC-SHA1 over URL+params) and SES (SigV4) come after C5. Both need extra engine features.
- Tests: fixtures per op, the sandbox-vs-recording shape contract, inbound fixtures, and an acceptance app in `apps/` (a checkout) that runs only against sandbox and the verify sink.

**C6: OpenAPI import (about +400).**
- `runtime/connectors/openapi.mjs` (pure, JSON in, descriptor out) and a CLI `--import-openapi spec.json --name x`. The output is a draft to be reviewed and committed.
- Maps operationId → op, parameters and requestBody → `input`, 2xx response → `output`, securitySchemes (apiKey, bearer, basic) → `auth`. `idempotent` defaults true for GET/PUT/DELETE, false for POST unless an idempotency header parameter exists.
- `$ref` is resolved locally only. `oneOf/allOf/anyOf` beyond the trivial cases, callbacks and oauth flows are **omitted with a listed `unsupported` note**. Never guess. YAML input is out of scope (zero deps).
- Tests: golden imports from small specs and a fuzz test (any input either yields a descriptor that passes `descriptor.mjs` or a listed omission). Mutations: `$ref` cycles, POST defaulting to idempotent.

**C7: settings screen (about +350).**
- `runtime/routes/settings.mjs` and `render/settings.mjs`, gated by a new `vc.settings` (an admin, like `vc.outbox`, context.mjs:97).
- Per connector: mode badge, breaker state, 24 h sent/failed counts, drift count, slots as set/unset. Set or replace a secret through a password field (the value is never echoed), a "send test" through the sandbox, and a webhook URL to copy.
- Tests: no secret value in any HTML or JSON response; a non-admin gets 403.
- Mutations: the value echoed after save, a secret list accessible to non-admins.

## 8. Risks and open questions

**Decide now (they change C1's shape or are hard to reverse):**
1. **Descriptor as JSON data vs plugin code.** Recommended: JSON, with the engine in `runtime/`. Cost: providers needing logic (SigV4, OAuth token refresh) need an escape hatch. Proposal: a descriptor may name a pure `codec` module later; not in C1.
2. **Schema language.** The JSON-Schema subset (needed for OpenAPI import) vs the app's field-spec strings (spec.mjs, FORMAT.md field kinds). Recommended: the JSON-Schema subset in the descriptor, plus the field-kind → schema-type map for the checker (2.4).
3. **`kind` = descriptor name and one synthesized transport per descriptor**, with `connector.call` as the single new block. The alternative (a generated block per op) makes the catalog and search noisy.
4. **`http` and `mail` keep today's semantics** (`http` live-only, `mail` sandbox-only), so no app needs a deploy step. Otherwise the 4 sink apps break and every acceptance run needs a `deploy.json`.
5. **New columns and statuses** (`unknown`, `nextAttemptAt`, …): the `_outbox` migration is additive (migrate.mjs:72), but pg needs quoted names (POSTGRES.md:184). Decide the `unknown` status semantics for non-idempotent timeouts now, because verify and the UI read `status`.
6. **Where mode lives:** `deploy.json` beside the db (recommended) vs a table vs the secret store. It must not be in app.json.
7. **Inbound before the session gate** is a new unauthenticated route. Confirm the path (`/hook/<connector>`) and that it is exempt from the "Please sign in." gate.

**Can wait:**
1. Sensitive inputs (PAN, health data): store them encrypted in the outbox payload, or forbid them and require provider tokens (the current default: forbid).
2. Rate limiting and inbound IP allow-lists.
3. Multi-instance (pg) behaviour of the breaker and the flusher; both are designed on atomic UPDATEs, and the claim/lease from POSTGRES.md:124 already covers the outbox.
4. OAuth flows (token refresh) and per-user connections (e.g. each user links their own Google Calendar): needs an "account" concept beyond one secret set per deployment.
5. Streaming and file operations (S3, LLM streaming); pagination and batch operations.
6. `--connectors drift` scheduling and the alerting destination.
7. Secret-store backends (Vault/KMS) behind the same `opts.secret` interface.
8. Whether the settings screen may switch to live (the recommended default: CLI only, with UI confirmation later).

**Risks:**
- The engine grows into a general HTTP DSL. Mitigation: no expressions or conditionals in templates; anything else is a `codec`, or the connector is not covered.
- The `deliver` opts and TransportType change touch every transport. The extension is additive (`opts` is a bag), and existing transports ignore it.
- Duplicate effects if a lease expires during a slow request: bounded by `timeoutMs ≤ LEASE_MS/2` and by the idempotency key, but non-idempotent ops still risk one duplicate across a crash (documented, as in FORMAT.md:202).
- The mutation gate rewrites runtime files in place (AGENTS.md). Every new module needs re-pointed, exact-text mutations, which is the biggest per-PR cost.
- `payment` (sandbox, in-transaction authorisation) and Stripe (async, event-driven) have different flows. Unifying them in the docs is a decision for C5, not C1.

## 9. Decisions (maintainer, 2026-09-29)
1. Descriptor = JSON data; the engine lives in `runtime/connectors/`. A pure `codec` escape hatch may come later, not in C1.
2. Schemas = a JSON-Schema subset in the descriptor; the checker maps field kinds to schema types.
3. `kind` = descriptor name, one synthesized transport per descriptor, a single new block `connector.call`.
4. `http` stays live-only and `mail` sandbox-only as today, so no existing app needs a deploy step.
5. A non-idempotent op that times out ends in status `unknown` — never retried automatically; `/outbox` shows it with "mark sent" / "retry" actions for an operator.
6. Mode (sandbox/live) lives in `deploy.json` beside the database, switched only by the CLI (`--connectors live NAME --confirm`).
7. Inbound route `POST /hook/<connector>`, exempt from the session gate; authenticated only by the descriptor's signature recipe; JSON answers only.
Order: C1 → C3 (retries/backoff/breaker, also the Horizontal-scaling "retry with backoff") → C2 secrets → C4 inbound → C5 providers (Stripe, Postmark, Slack; recordings only) → C6 OpenAPI → C7 settings screen.

## 10. C1 as built

Where the code differs from, or narrows, the sketch above:
- **What a descriptor may say today.** Top level: `descriptor`, `name`, `title`, `version`, `base`,
  `config`, `timeoutMs`, `legacy`, `operations`. An operation: `summary`, `idempotent` (required), `input`
  (a schema of `type: object`), `request` (`method`, `url`, `headers`, `body`; JSON only), `output`,
  `result`. Everything else (`modes`, `auth`, `retry`, `breaker`, `inbound`, `sandbox`, `outcomes`,
  form encoding) is an error until its stage lands: an unknown key fails closed.
- **Schema.** The subset of section 2.1 plus the annotations `default`, `title`, `description`, `message`
  (the text of a failure at that node, `{value}` is the value) and `hint`. `additionalProperties` is
  closed whenever `properties` is given (an object with no `properties` is free-form); a provider's *answer*
  is validated open, so extra fields are not drift.
- **Templates** have `{config.x}`, `{input.x}`, `{secret.x}`, `{base}` (the descriptor's `base`, over
  `config`) and `{"$": "input.x"}`; `{key}` is rejected until retries exist. The object key `"..."` spreads an
  object into its parent (how `http` merges the connector's `headers`). An absent value is empty text inside
  a string and leaves its property out of an object.
- **`legacy`.** A row queued without an `op` (`http.send`, `connector.send`, and every row of a database
  from before C1) is delivered as the descriptor's `legacy` operation with `{ body: payload }` and its own
  `target` as the url. Only `http` names one. The legacy blocks were *not* changed to set `op`: their
  payload is the raw body, and the delivery is byte-identical to 0.2.0.
- **`connector.call`.** `input` is resolved (`@row.f`, `= expr`), completed with the schema's defaults and
  validated when the step runs; the row's `payload` is that input and its `target` the built url. `ref` is
  accepted and shape-checked (`"@row"`, `"@found"`), and has no effect yet: the events that use it arrive
  with settlement (section 2.3).
- **URL safety (added after review).** `{input.*}` and `{key}` in a `url` are percent-encoded with
  `encodeURIComponent`; `{config.*}`, `{base}` and literals stay raw. The descriptor checker rejects a url
  template where an input or key would sit in the origin (before the first `/` after the host). Header
  values with CR/LF fail the delivery. Consequently `http`'s `send` has no `path` input (the legacy
  `http.send` block still appends its `path` as before: its author writes it into the graph).
- **Secrets.** `{secret.x}` may appear in headers and bodies, never in `url`/`method`/`base`. There is no
  store: delivery fails closed with `secret "x" cannot be resolved: the secret store is not available yet`
  (C2 supplies `opts.secret`). `app.json` may not hold a secret: a string under a key matching
  `key|token|secret|password|authorization`, or shaped like `sk_…`, `Bearer …` or a JWT, is a checker error
  unless it is `{secret.name}`; under `secrets` (the slot to store-name map of C2) nothing is checked.
- **Answers.** An operation with `output` has its answer read on 2xx: `response` keeps the text (16 KB),
  `result` the fields `result` names, `drift` is 0 or 1. Without `output` the body is never read. A non-2xx
  answer is `failed` with `HTTP <code>` and no body kept.
- **Not yet:** modes, sandbox rules, idempotency keys, retries, `unknown` status, settlement events,
  inbound. The columns for them (`mode`, `idemKey`, `nextAttemptAt`, `settledAt`, `refEntity`, `refId`)
  are added by the stage that needs them.

## 11. C3 as built

Where the code differs from, or narrows, section 4:
- **Modules.** `runtime/connectors/backoff.mjs` (a pure leaf: `classify`, `decide`, `delayFor`, `retryAfterMs`,
  `breakerStep`, `idemKeyOf`, `checkPolicy`), `runtime/settle.mjs` (turns what a transport returned or threw
  into the outbox patch and the breaker event), `runtime/clock.mjs` (`systemClock`, `resolveClock`); `outbox.mjs`
  keeps `deliver`/`flush`, `startFlusher` is in `server.mjs`, the breaker and queue queries are in `store/state.mjs`.
- **Columns and tables.** `_outbox` gains `nextAttemptAt` and `idemKey` (added in place to old databases, like
  `claimedAt`); `_breaker(key, connector, mode, state, failures, openUntil, cooldownMs, probeClaimedAt)` is new,
  keyed by `connector|mode`, all names quoted through the dialect. `cooldownMs` is stored so the doubling survives
  a restart. `settledAt`, `mode` and `refEntity/refId` belong to stages that need them (C2, settlement).
- **Only `idempotent` gates a retry.** An operation with an `idempotency` header is still retried only when it
  says `idempotent: true`; declaring the header is how the key reaches the provider, not a promise of safety.
  So a Stripe-style POST with a key is written `idempotent: true` by its author, who knows the provider dedups.
- **Faults.** The engine tags a request that throws with why (`timeout`, `unsent`, `net`); anything thrown
  before the request exists (a bad template, a missing secret) or by a plugin transport is final and tells the
  breaker nothing, so a plugin that returns `failed` without a code behaves as before.
- **The breaker's mode** is `live` until C2 supplies `opts.mode`. A `4xx` counts as a sign of life: it resets
  the failure count (and closes a half-open breaker). A probe whose outcome tells nothing (a plugin failure with
  no code) leaves the breaker half-open until its lease (the outbox lease) runs out.
- **Probe atomicity.** The claim is one `UPDATE` that matches only the state the caller read; failures and
  successes are read-modify-write, atomic within one process. On pg with several instances they need
  `SELECT … FOR UPDATE` (S6), like the outbox claim.
- **The clock.** `serve({ clock })` reaches `flush`, `deliver`, the engine's timeout timer (an `AbortController`
  fired by `clock.setTimer`, so a fake clock can time a request out) and `startFlusher`. `flush({ now })` still
  works and overrides only the reading of the time. `tests/arch.test.mjs` bans wall-clock reads and
  `Math.random` in the delivery modules.
- **The flusher.** A self-rearming interval timer plus a one-shot to the earliest `nextAttemptAt` still ahead,
  re-armed after every tick; a retry scheduled by a request's own flush waits for the next tick (at most the
  interval). It does not yet re-fire unsettled events (there are none until settlement lands).
- **Operator.** `POST /outbox/:id/retry` resets `attempts` and `nextAttemptAt` and flushes (an open breaker still
  holds the row back); `POST /outbox/:id/sent` settles only an `unknown` row, guarded in the `UPDATE`.

## 12. C2 as built

Where the code differs from, or narrows, sections 2.1, 3 and 6:
- **Modules.** `runtime/secrets.mjs` (the store: node:crypto, node:fs), `runtime/deploy.mjs` (`deploy.json`,
  `modesOf`, `modeOf`, `connectorModes`, `connectorEnv`: what a running app delivers with), `runtime/admin.mjs`
  (the `--secrets` and `--connectors` commands, called by `cli.mjs`), `runtime/connectors/redact.mjs` (masking, a pure
  leaf) and `runtime/connectors/sandbox.mjs` (the rule engine and its checker, pure). There is no `_deploy_log`
  table and no `--connectors rekey` yet; the file is plain and diffable.
- **The store.** `secrets.enc` is `{v: 1, alg: "aes-256-gcm", salt, nonce, tag, ct}`; the key is
  `hkdfSync('sha256', master, salt, 'canopy-secrets-v1', 32)`; the AAD is `<app>|1`. Every write uses a fresh salt
  and nonce, goes through a temporary file and a rename, mode 0600. The master key is `CANOPY_MASTER_KEY` (base64,
  exactly 32 bytes) or `secrets.key` (created by the first `set`); reading a store that does not exist needs no key.
  API: `get(name)` returns `[name, name.prev]` (those that exist), `current(name)` the value of the name alone,
  `set`, `remove`, `names`, `values` (for masking). A name is `[A-Za-z_][\w-]*` with an optional `.prev`.
- **Resolution.** `{secret.slot}` is read by the engine when the request is built, in a delivery only: the store name
  is `connector.secrets[slot]` or else the slot. Only the current value signs a request: a `.prev` alone does not stand
  in for it. A missing secret throws a plain error (no `fault`), so `settle` makes the row `failed` for good and tells
  the breaker nothing. `secrets` in a connector is checked only for shape (slot to name).
- **Masking.** `deliver` masks every value of the store (all names, `.prev` included) in what the transport returns,
  in the error it throws, and in every trace line it writes, in three forms: as written, JSON-escaped and URL-encoded.
  A store that cannot be read masks nothing (it resolved nothing) and the delivery reports the store's own error.
- **Modes.** A descriptor's `modes` (absent: `["live"]`) and `sandbox` are checked at load: modes are `sandbox` and/or
  `live` once each; the `sandbox` mode needs rules for every operation and rules need the mode. `http` is `["live"]`,
  `mail` is `["sandbox"]` (its transport records the letter, as before). `flush` reads `deploy.json` once per flush
  and gives every row its connector's mode; `deliver` refuses a mode the kind does not offer; the breaker is keyed by
  the real mode. A `deploy.json` that is not the shape stops `serve()` like an invalid graph. The outbox row does not
  record the mode it was delivered in (its breaker and `/outbox` do).
- **Sandbox.** Rules and `when` comparisons as in FORMAT.md; the answer is shaped like a `fetch` Response and goes
  through `mapResponse`, so `output`, `result`, `drift`, `Retry-After` and retry classification behave as with a real
  provider. `{key}` in a sandbox body is the row's idempotency key. No rule matching fails the delivery for good.
- **Command line.** `--connectors status | live NAME --confirm | sandbox NAME`, `--secrets set NAME | list | rm NAME`.
  A value comes only from stdin (one trailing newline dropped); a value given as an argument is refused. `live`
  refuses, changing nothing, without `--confirm`, for a mode the kind does not offer, and while a secret its live
  requests read is missing (checked by store name, current value). The commands exit 1 with a message on any refusal
  or a wrong master key. `CANOPY_SECRET_VALUE` and the `_deploy_log` of section 3 were not built.
- **Not yet.** Rotation is by hand (`--secrets set NAME.prev`, then `set NAME`); a descriptor cannot yet ask for the
  list of values (C4's signature check will); the https-only check of live bases and the settings screen (C7).

## 13. C4 as built

Where the code differs from, or narrows, sections 2.1, 2.2, 5 and 6:
- **Modules.** `runtime/connectors/signature.mjs` (a pure leaf, `node:crypto`: `verifySignature`, `signHeaders`,
  `safeEqual`, `checkRecipe`), `runtime/connectors/inbound.mjs` (a pure leaf over schema/template: `checkInbound`,
  `typeOf`, `eventIdOf`, `valuesOf`, `payloadProblems`), `runtime/routes/hooks.mjs` (the route), `rawBody` in
  `routes/context.mjs`, `_inbound` and its three queries in `store/state.mjs`/`migrate.mjs`, `fireInbound` in
  `interp.mjs`, `inbound:` events in `check/events.mjs`, the `simulate` command in `admin.mjs`, the pruning in
  `server.mjs#startFlusher`.
- **The descriptor block, as built.** `inbound` is `{signature, secret, toleranceS, eventId, type, events}` (the
  sketch of 2.1 nested `secret` and `toleranceS` inside `signature`; here the recipe says how, the block says with
  what and how late). `signature` is `{scheme: "stripe"}` (optional `header`), `{scheme: "slack"}`,
  `{scheme: "basic"}` or `{scheme: "hmac", header, algo, encoding, prefix?, signed?, timestampHeader?}`; unknown keys
  per scheme are errors, `timestampHeader` exists only with `signed: "ts.raw"` (a timestamp outside the signed text
  proves nothing), `toleranceS` is 1 to 86400 (default 300). `type` is a `$.path` into the JSON body or
  `{"header": "name"}`; `eventId` is a `$.path` into the signed body **only**: no recipe signs headers, so a header id
  (which a replayer of a captured request could change into a new event) is a descriptor error. `events` maps a type to `{schema, map?}`: `schema` (type object) is applied open (a provider
  may send more), `map` names the values the app's steps get. The `match` rule and the `ref`/`amount` mapping of
  the sketch became `type` + `map`: there is one rule ("the type is the key") and no expression language.
- **The graph side.** `{"inbound": "<connector>.<type>", "do": [...]}` in `events` (instead of `on`; both is an error):
  the connector is up to the first dot, the type (which may have dots) is the rest. The checker refuses an unknown
  connector, a kind whose descriptor has no `inbound`, and a type the descriptor does not declare. The steps have no
  row and no user; the payload arrives as `@values.<name>` (and `= values.name`): the `map` picks when there is one,
  else the top-level scalars of the payload. Nested values need a `map`. `@values.x` is not checked, like every
  `@values` name. `secretSlots` includes the inbound slot, so `--connectors status` shows the webhook secret as
  set/MISSING and `--connectors live` refuses while it is missing.
- **The route, in order.** Unknown connector, no `inbound`, or an inherited name (`constructor`) is 404; another
  method is 405 (`Allow: POST`); the body is read as bytes up to 1 MiB (413 and `Connection: close`, by declared
  length or while streaming, nothing past the cap kept); the signature is verified before anything is parsed (401
  `{ok:false,error:"unauthorized"}` whatever the reason; the reason is only in the trace line `webhook_rejected`);
  invalid JSON / no type / a payload the schema refuses / an unusable event id (missing, not text or integer, over
  255 characters) is 400 with a fixed word; an unknown type, or a declared one that no graph event subscribes to, is
  `200 {ok:true, ignored:true}` with a `webhook_ignored` trace (the type, cut at 64 characters, is the one thing of a
  payload the trace keeps); then one transaction: `inboundSeen`, `inboundAdd`, the steps. A duplicate is
  `200 {ok:true, duplicate:true}`; a throwing step rolls everything back and answers `500 {ok:false, error:"failed"}`
  (the message goes to the trace as `webhook_failed`, never to the client). After the commit the outbox is
  flushed; a flush that throws is traced and does not change the answer. The answer is always JSON, `accept` is
  ignored, no cookie is set, no session is read for any decision.
- **Dedup.** `_inbound(key PRIMARY KEY, connector, eventId, receivedAt)` with `key = connector|eventId`: the primary
  key is the UNIQUE(connector, eventId) of the design (connector names cannot hold `|`), as `_breaker` does. The read
  and the insert are in the steps' transaction, so the row exists exactly when the steps committed; a second
  instance that passes the read at the same moment fails the key and answers 500, and the provider's retry finds
  the row. Rows older than `INBOUND_RETENTION_MS` (30 days) are deleted by the flusher, at most once an hour, on
  the injected clock. Not built: the flusher does not run under `AG_NO_TIMERS`, so verify never prunes.
- **Signatures.** `stripe` reads `t=<unix>,v1=<hex>[,v1=...]` (any `v1` may match) over `t.raw`; `slack` reads
  `x-slack-signature` (`v0=` + hex) over `v0:<x-slack-request-timestamp>:raw`; `hmac` is sha256/sha1, hex/base64, an
  optional prefix, over `raw` or `ts.raw`; `basic` compares the `Authorization` header with `Basic` + the base64 of
  the stored value (store `user:password`). Every candidate is compared with `timingSafeEqual` after an equal-length
  check (a length mismatch is a plain refusal and does not throw), against every secret of the list
  (`get(name)`: the name and `name.prev`) without stopping at the first match. The replay window is applied only
  after the signature is proven, so a forged stale request is reported as a bad signature. No secret in the store is
  a refusal (`secret_not_set`), never a pass. Reasons: `signature_missing`, `signature_malformed`,
  `signature_mismatch`, `timestamp_stale`, `secret_not_set`.
- **`--connectors simulate NAME EVENT --data FILE [--port N]`.** `FILE` is the complete payload as the provider would
  send it (its type and id where the descriptor looks); the command refuses unless it carries the event type asked
  for, then signs the bytes with the stored secret and POSTs them to `http://127.0.0.1:<port>/hook/NAME` (default
  port 8901), prints the status and the answer, and exits 1 on a non-2xx. A header-carried type is set from `EVENT`;
  the event id is the file's own, so the same file twice is the same event. There is no fixed
  development secret: with none in the store it refuses and says which name to set. verify puts the secrets an app's
  `checks.mjs` exports (`export const secrets = {...}`) into the app's store before boot.
- **What an unauthenticated POST can do** (the route is the only unauthenticated write path; everything below is
  bounded): (1) read at most 1 MiB and hash it (HMAC, a few milliseconds) per request: bounded by the cap, the
  server's header/request timeouts and nothing else (no rate limit: "can wait" in section 8); (2) append one fixed-size
  trace line per refused request (`webhook_rejected`, connector name from the graph, a reason code; never the body, the
  header or a secret): disk growth proportional to the request rate, unbounded without a rate limit; (3) nothing else
  without a valid signature: no parse, no row, no step, no outbox row, no answer that depends on the payload. With a
  valid signature (the provider, or anyone holding a captured request): (4) one `_inbound` row and the event's
  steps per distinct event id, at most once per id for 30 days; a replay of a captured request inside the window is a
  duplicate, and a scheme with a timestamp also refuses it after `toleranceS`; (5) the event id can only come from the signed body
  (a header id is a descriptor error), so a replay cannot become a new event. Residual: a header-carried `type` is not
  signed, so a replayer could route a captured body to another declared type whose schema it also satisfies.

## 14. C5 as built

Where the code differs from, or narrows, sections 2.1, 5, 6 and 7 (C5):
- **What shipped.** Three descriptors as data, `connectors/stripe/descriptor.json`, `connectors/postmark/descriptor.json`
  and `connectors/slack/descriptor.json`, each `"modes": ["sandbox", "live"]` (sandbox is the default, so an app that
  lists one runs without a deploy step and sends nothing until `--connectors live NAME --confirm`), each with a `sandbox`
  block for every operation. An app lists them like any plugin (`"plugins": ["../../connectors/stripe/descriptor.json"]`).
  The reference app is `apps/checkout`. No runtime module names a provider.
- **Fixtures are hand-written, not recorded.** The build had no keys, so every file under `connectors/<name>/fixtures/` is
  written from the provider's public documentation and says so in itself: `"recordedAt": null, "source": "docs"`, a
  `note` naming the page, and a `providerVersion`. They have the shape of section 6 (`op`, `case`, `request`, `response`)
  plus the `input` (and connector `config`, and the `idemKey`) the request was built from, and, where the delivery is not
  the plain reading of the status, an `outcome`. Inbound fixtures are `inbound.<type>.<case>.json`: the unsigned request
  (`headers`, `body`) and the `values` the steps should get (a Slack `url_verification` fixture has the expected `answer`).
  They are signed by the tests with a fixed secret on an injected clock. **The first real recording replaces a fixture's
  `source` with `"recorded"` and a date**; until then a green contract test proves the descriptor agrees with the
  documentation as read by its author, not with the provider. There is still no `--connectors record` or `drift` command.
- **The hermetic helpers** are test code: `tests/replay.mjs` has `loadFixtures`, `replayFetch(fixtures)` (a `fetchImpl`
  that matches on method, url and the canonical body and **throws `replay miss` on anything else**: no default answer,
  no network), `canonicalBody`, `redactHeaders` and `suspicious(text)`, the scan used by the fixture test (`\bsk_`, other
  Stripe key shapes, `Bearer `, Slack tokens, JWTs, and any token of 32+ characters that is hex or has entropy of 3.5 bits
  or more; urls and media types are skipped). `tests/providers.test.mjs` holds the contract tests: (a) every sandbox
  rule answers and a success validates against the operation's `output` (`drift` 0); (b) for each fixture the sandbox's
  answer has the same keys and types, **a subset** of the recording (the sandbox may not invent a field the provider
  lacks, the real answer may have many more); (c) the request built for the fixture's input is the recorded one
  after redaction (a form body byte for byte, so nesting is covered); plus each recording delivered through `deliverRow`
  with `replayFetch`, the inbound fixtures verified, parsed and routed through the real `/hook`, and the operations run
  through a server in sandbox mode. `tests/connectors_c5.test.mjs` tests the engine features below.
- **Form encoding** (`runtime/connectors/form.mjs`, `"request": {"encoding": "form"}`). The body object is flattened the
  way bracket-syntax providers read it: `{"metadata": {"order": "7"}}` is `metadata[order]=7`, a list is `a[0]=x`, an
  object may go any depth; `null` and absent values are left out, booleans are `true`/`false`, every name and value is
  percent-encoded except the brackets (so a flat key written `metadata[order]` and the nested object are the same bytes).
  The content type `application/x-www-form-urlencoded` is set unless the descriptor sets one. The checker refuses an
  encoding other than `json` (the default) or `form`, and a form body that is not an object.
- **The idempotency header** already existed (C3: the top-level `"idempotency": {"header": "Idempotency-Key"}` sends the
  row's key; the key is fixed at enqueue and the same on every retry). Stripe declares it, and all four Stripe
  operations say `"idempotent": true` (Stripe deduplicates on the key; a GET is idempotent anyway), so they retry on a
  timeout, a 429 and a 5xx. The key is sent on a GET too: Stripe ignores it there. Postmark and Slack have no
  idempotency mechanism, so `sendEmail` and `postMessage` are `"idempotent": false`: after an answer that is a failure
  they are not retried, and after a timeout they end `unknown` for an operator, never a second letter or message on a guess.
- **An answer that is HTTP 200 and a failure** (`"failure"` on an operation: `{path, equals, error?, code?, codes?}`).
  Slack answers `{"ok": false, "error": "channel_not_found"}` with status 200. Decision: the rule names the flag
  (`"$.ok"` equal to `false`), the reason (`"$.error"`) and the **status the failure counts as**: `codes[reason]`
  if the reason is listed, else `code`, else 400 (statuses are 400 to 599; an inherited name such as `constructor` is
  no reason). The delivery is then an ordinary failed one: `status: "failed"`, `code` the mapped status, `error:
  "rejected: <reason>"` (the provider's text cut to 100 characters and cleaned to `[\w .:-]`), `response` kept, `result`
  and `drift` empty; and **the retry classifier, `Retry-After` and the breaker see an ordinary status**, with no special
  case in them: Slack's `ratelimited` is 429, `internal_error`, `fatal_error`, `service_unavailable` and
  `request_timeout` are 503 (retryable, and counted against the breaker), `invalid_auth`, `not_authed`, `token_revoked`
  and `account_inactive` are 401, `missing_scope` 403, and any other reason (`channel_not_found`, `is_archived`,
  `msg_too_long`, …) the default 400 (permanent, and a sign of life for the breaker). Because `postMessage` is not
  idempotent a 503 is **not** retried, but it does count toward opening the breaker. A 200 answer that is not JSON, on
  an operation with a `failure` rule, cannot be told from a success, so it fails as 502. A real HTTP 429 (what Slack
  sends for rate limits) never reaches the rule: it is an HTTP error as before and its `Retry-After` is honoured. The
  rule is read in sandbox mode too, so a sandbox rule `{"body": {"ok": false, "error": "channel_not_found"}}` exercises it.
- **Inbound, what C5 added to the block** (all generic, all checked in `inbound.mjs`):
  - `challenge: {type, equals, echo}`, the one deliberate echo. A request whose `type` path holds `equals` (Slack's
    `url_verification`) is answered `200 {"challenge": <the echo path's value>}`. It is **explicit** (only a descriptor that
    declares it, only its connector), **after the signature** (a bad, missing or stale signature is the usual 401 with no
    echo; the replay window applies), **bounded** (the value must match `^[A-Za-z0-9._~-]{1,128}$`, else `400
    invalid_challenge` and the refusal does not repeat it) and **not an event** (no dedup row, no steps, a repeat is
    answered again); the trace has `webhook_challenge`, never the value. It is checked before the type, so Slack's
    `type` (`$.event.type`, absent in a challenge) is not needed.
  - `eventId` may be a list of up to four body paths; the id is then the JSON array of the pieces (so no piece can run
    into the next), and any missing or empty piece is "no id" (400). An event may carry its own `eventId`, which wins
    over the block's. Postmark's `SubscriptionChange` has no id of its own, so its id is `[MessageID, Recipient,
    ChangedAt]`; `Bounce` uses `ID`. (Postmark's `ID` is an int64: one above 2^53 is "no usable id", the documented
    example in Postmark's page is such a number, real ones are not.)
  - `require: ["order"]` on an event: names of its `map` that the payload must carry (not null or absent). An event
    without one is answered `200 {ok:true, ignored:true}` (trace `webhook_ignored` with `missing`), **before** the dedup
    row, so nothing is remembered and no step runs. Why: `@values.order` that is absent is dropped from a `where`,
    so `db.each Order where {id: "@values.order", status: "paying"}` selected *every* paying order, and a Stripe
    payment made outside the app (no `metadata.order`) would have marked all of them paid. The checkout app found it.
    All three Stripe events require `order`. This is a footgun of `where` itself (an absent filter value is skipped, as a
    list screen needs), recorded here and not changed in the runtime.
- **Stripe.** Operations `createPaymentIntent`, `retrievePaymentIntent`, `confirmPaymentIntent`, `createRefund` (form
  bodies, `Authorization: Bearer {secret.apiKey}`, `Stripe-Version` pinned to the descriptor's version, amounts in the
  smallest unit, lower case currency, `metadata` a free object that becomes `metadata[k]`). Inbound: `stripe` signature
  on `webhookSecret`, window 300 s, events `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `charge.refunded`, mapped to `intent`, `order` (from `metadata.order`), `amount`/`currency`, `reason`, `charge`,
  `refunded`. Sandbox: the card `pm_card_chargeDeclined` is a 402, `confirm: true` with a payment method is
  `succeeded`, a payment method alone `requires_confirmation`, nothing `requires_payment_method`; the fake id is
  `pi_sbx_<idempotency key>`, so a retry gets the same one.
- **Postmark.** `sendEmail` (JSON, `X-Postmark-Server-Token: {secret.serverToken}`, `From` and `MessageStream` from the
  connector's `from` (required) and `stream` (default `outbound`)). Inbound `basic` on `webhookAuth` (the store value is
  `user:password`, set in the webhook URL's credentials at Postmark): events `Bounce` and `SubscriptionChange` (type
  `$.RecordType`). Basic credentials do not cover the body and have no clock, so a captured request can be replayed
  within the 30 days of dedup, which is what dedup is for. Sandbox: `inactive@example.test` is a 422 (ErrorCode 406).
- **Slack.** `postMessage` (`Authorization: Bearer {secret.botToken}`; the channel is an id or `#name`). Inbound `slack`
  on `signingSecret`, type `$.event.type`, id `$.event_id`, the `url_verification` challenge, events `app_mention` and
  `reaction_added`; `message` is not declared on purpose: the bot's own messages would come back as events. Sandbox:
  `#nowhere` answers `channel_not_found` and `#flaky` `internal_error`, both with HTTP 200 and `ok:false`.
- **The flow Stripe needs is two-phase** (section 2.3's limitation, still true: settlement events are not built). The
  graph cannot read the PaymentIntent's id from the call's answer, so the order id travels in `metadata.order` and the
  webhook brings it back: the order is "paying" after the call and "paid" only when the signed event arrives. The receipt
  and the staff notice are sent from that event's steps.
- **Not built.** `--connectors record` and `drift`; Twilio and SES; a Stripe Checkout/Elements flow (the app
  uses the test payment method `pm_card_visa` in the transition, so it is a test-mode demo, not a payment page).

## 15. C6 as built

Where the code differs from, or narrows, section 7 (C6):
- **Modules.** `runtime/connectors/openapi.mjs` (`importOpenapi(spec, {name})` → `{ descriptor, unsupported }`, pure, layer 0:
  naming, security, servers, the 2xx answer, and the last word of the descriptor checker), `oas_schema.mjs` (a schema of the
  document as the schema subset, `$ref`, cycles, `allOf`) and `oas_request.mjs` (parameters and body → `input` and the
  request template). The command is `admin.mjs#importCommand`, called by `cli.mjs` before the graph is read:
  `node runtime/run.mjs --import-openapi spec.json --name x [--out connectors/x/descriptor.json]`. Without `--out` the
  descriptor goes to stdout (pretty, two spaces; the key order is fixed by the importer, so the same document gives the
  same bytes); with it the file is written (its directory made). Exit 2 for a missing file name or `--name`, exit 1 for a
  document that is not JSON (**YAML is out of scope**: the runtime has no dependencies, convert it first), that is not
  OpenAPI 3.0/3.1 (Swagger 2.0 is named as such), or whose result would not pass `descriptor.mjs` (nothing is written; it
  always should pass, so that is a bug, except for a document with no operation at all). The list of what was not mapped
  goes to stderr (`not mapped: <json pointer>: <why>`) with a closing line that the result **is a draft for a human to
  review and commit**, and the secret slots it reads.
- **`unsupported` is `[{ path, message }]`**, `path` a JSON pointer into the document (`#/paths/~1pets/get/parameters/1`),
  without duplicates. The rule is the brief's: nothing is guessed, anything not mapped is listed. Only pure annotations
  (`example`, `readOnly`, `deprecated`, `x-…`) and a `format` the subset lacks (`int64`, `uuid`, `date`) go quietly:
  they do not change what a value may be.
- **What a descriptor can say, and so what is mapped.** `modes` is `["live"]` and there is **no `sandbox`** (descriptor.mjs
  accepts that: a live-only descriptor needs no rules; the author adds them and the mode). No `retry`, `breaker`,
  `timeoutMs`, `result`, `failure` or `inbound`: those are decisions of the author.
- **Names.** `operationId` sanitised to `[A-Za-z_][\w-]*` (anything else becomes `_`, a leading digit gets a `_`), else
  `<method>_<path>` (`get_pets_petId`); a name already taken becomes `name_2`, `name_3`, in document order (paths and then
  GET, POST, PUT, PATCH, DELETE), so the same document always gives the same names.
- **Parameters.** Path, query and header parameters of a path item and of its operation (the operation's win by name and
  place; `$ref` into `#/components/parameters` followed) become properties of `input`, named as a template can name them
  (`page.size` is `page_size`); path parameters go into the url as `{input.x}`, **required** query parameters (and
  optional ones that have a `default`, which the engine fills in) as `?name={input.x}`, headers as `{"$": "input.x"}`
  (an absent optional header is simply not sent). A url template cannot leave a query parameter out when it is absent,
  so **an optional query parameter without a default is listed, not mapped**. Not mapped either: cookie parameters, any
  parameter that is not a string, number, integer or boolean (arrays, objects, no schema), a path `style` other than
  `simple`, the headers `Accept`, `Content-Type` and `Authorization` (OpenAPI says to ignore them). **A required thing that
  cannot be mapped (a required parameter, a required body, a path placeholder with no path parameter) leaves its whole
  operation out**, listed; an optional one only itself.
- **Body.** `application/json` (or any `+json`) becomes a JSON body (the importer adds `content-type: application/json`: the
  engine sets a content type only for a form), `application/x-www-form-urlencoded` an `encoding: "form"` body; JSON is
  preferred when both are given. An object with properties a template can name (and none clashing with a parameter) is
  **flattened**: each property is an input and the body is `{"name": {"$": "input.name"}}`; the properties the body
  `required` are required inputs whatever `requestBody.required` says (the importer always sends a body). Any other body
  (a list, a string, a property name like `metadata[order]`, a clash) is the one input `body` and `{"$": "input.body"}`.
  Multipart, XML, octet-stream and the like are listed. An object schema of a request is **open** unless the spec says
  `additionalProperties: false` (the OpenAPI default; the subset's own default is closed), written `true` where it
  matters; the flattened top level is the exception, and its explicit `additionalProperties` is listed.
- **Answer.** The first 2xx (ascending, `2XX` included) with a JSON body gives `output` (its schema; a schema that came out
  as `{}` gives none), and `accept: application/json` is sent. A 2xx that has a body of another type is listed. `result`
  is for the author. `default` and 4xx answers are not read.
- **Auth.** There is no `auth` key in a descriptor as built (section 10): authentication is a header with a secret slot,
  named after the security scheme, `{secret.<scheme>}`. `apiKey` in a header becomes that header, `http` `bearer`
  `authorization: Bearer {secret.<scheme>}`, `http` `basic` `authorization: Basic {secret.<scheme>}`, **and the list says the
  slot must hold `base64(user:password)`** (a template cannot encode). The security requirement of the operation, else
  the document's, is read as alternatives: the first one every scheme of which can be mapped is used (an empty one means none).
  Listed and not mapped: `apiKey` in the **query** (the secret would be in the url, which the outbox shows) or a cookie,
  `oauth2`, `openIdConnect`, `mutualTLS`, other `http` schemes, an undefined scheme; if no alternative can be mapped the
  operation is imported without authentication and the list says so.
- **Idempotency.** `idempotent` is true for GET, PUT and DELETE and false for POST and PATCH; HEAD, OPTIONS and TRACE are
  listed (`descriptor.mjs` has no such method). A header parameter whose name matches `/idempotency[-_]?key/i` is not an
  input: the descriptor gets the top-level `"idempotency": {"header": <that name>}` (the row's key goes there, as in
  section 11) and the operation is `idempotent: true`, as Stripe's are. One header serves the whole descriptor, so the
  first name wins; a spelling the descriptor cannot send (`Idempotency_Key`: letters, digits and `-` only) or a second name
  stays an ordinary input header, listed, and its operation is not idempotent. The engine sends the header on every
  operation, as for Stripe.
- **Base.** `servers[0].url` with its variables fixed to their defaults (listed), without a trailing `/`. Other servers, the
  servers of a path or an operation are listed. A document with no server, a relative one, or one that is not an http(s)
  url gets `"base": "{config.baseUrl}"` and a required `config.baseUrl` (a uri), listed.
- **`$ref`** is followed only into the document (`#/…`), also in a chain; an external, missing or malformed one is `{}` (a
  parameter, body or response: absent) and listed. A cycle is cut where it comes back: **that schema is `{}`** and the note
  names the path where it was cut and the schema. The work is bounded (48 levels, 20000 nodes: a document whose references
  fan out cannot blow up), and what is beyond is `{}`, listed once.
- **Composition.** `allOf` of plain objects is merged (properties, `required`, titles; members that describe a property
  differently, or are not plain objects, or disagree about `additionalProperties`, are **omitted whole**: `{}` or the key
  dropped, listed). `oneOf`/`anyOf` with one element is unwrapped; with more they are omitted, listed (the rest of the
  schema is kept). `not` is omitted, listed.
- **The subset.** `nullable: true` and `null` in a type list are dropped, **listed** (null is no longer accepted); a type
  list of several types drops `type`; `const` is a one-value `enum`; keywords the subset lacks (`exclusiveMinimum`,
  `multipleOf`, `minItems`, …), a schema-valued `additionalProperties` and a tuple `items` are dropped, listed; a `default`,
  `pattern` or length the subset's own checker refuses is dropped, listed. `required` names without a property are dropped,
  listed. Callbacks, webhooks, cookies and multipart are listed.
- **The checker has the last word.** The result is run through `checkDescriptor`; an operation it refuses (its path in the
  message) is left out and listed, until it passes. So the result passes, or has no operation and the list says so.
- **Proof.** `tests/connectors_openapi.test.mjs`: golden imports (`tests/golden/openapi/*.json` hold the descriptor *and*
  the list, so a construct dropped without a note changes the bytes; `UPDATE_GOLDEN=1` rewrites them) of five specs written
  for the tests in `tests/fixtures/openapi` (a CRUD, a form + basic + idempotency header, `$ref` cycles with
  oneOf/callbacks/webhooks, a pile of edge cases, a relative server), every imported operation built by the engine, and a
  round trip: a spec of Postmark's send operation gives the same request as the hand-written descriptor.
  `tests/connectors_openapi_fuzz.test.mjs`: 600 generated specs and 1250 damaged fixtures never throw, and always give a
  passing descriptor or a list that says why not. 15 `C6:` mutations.
- **Not built.** YAML; external `$ref`; `oauth2`; multipart; optional query parameters; arrays in parameters; response codes
  other than the first JSON 2xx; `failure`, `result` and `inbound` from a spec (the first two are the author's decisions, the
  third OpenAPI 3.1 `webhooks` describe the provider's calls to you in a way no descriptor reads yet).

## 16. C7 as built

Where the code differs from, or narrows, section 7 (C7). This is the last stage; the connector-library design is complete.
- **Modules.** `runtime/routes/settings.mjs` (the route and its three POSTs, layer 8), `runtime/render/settings.mjs` (the page),
  `vc.settings` in `routes/context.mjs` (an admin, like `vc.outbox`: `!perms.enabled || perms.isAdmin(user)`, so an app with no
  `roles` has the screen open exactly as it has `/outbox` open), the link in `render.mjs` navigation, `outboxStats` and a
  one-query `breakers` in `store/state.mjs`, `sandbox.test` in `connectors/sandbox.mjs` (the checker), `graphFile` in the
  request context (for the command the page prints). Routes: `GET /settings`, `POST /settings/secret`,
  `POST /settings/secret/remove`, `POST /settings/test`. Everything else under `/settings` is 404, a wrong method 405.
- **Who.** A customer, a guest and (through the session gate) a signed-out request get **403 on GET and on every POST**, HTML or
  JSON. The route answers its own 403 (not `ctx.deny`, which would send a guest's GET to the login page), and the refusal says
  nothing of connectors or slots. The nav link is shown to admins only. The check comes before the method, the origin and the
  body, so none of them is read for a non-admin.
- **CSRF.** The app has no token mechanism (forms are plain HTML, the session cookie is `SameSite=Lax`, which a same-site
  attacker or an old browser does not honour). So every POST needs a **same-origin check**: the `Origin` header, else the
  `Referer`, must parse as a URL whose host equals the request's `Host` header; neither header, `Origin: null` or a
  foreign host is 403 (`denied` in the trace) and nothing is read or changed. A browser always sends `Origin` on a POST,
  and the `Host` it sends is the one it connected to, so an attacker's page cannot make them agree.
- **What a card shows.** The kind, the mode (`deploy.json`; `interp.modes()`), the breaker of each mode the kind offers (one
  query for all breakers, a connector never seen failing is the resting state), `sent`/`failed`/`unknown`/`drift` counts of the
  rows last touched in the past 24 hours (**one grouped query** for all connectors: `outboxStats`), each slot of the
  descriptor (`secretSlots`, including the inbound one) with its store name and **set** or **MISSING** (the names of the store
  are read once for the whole page; an unreadable store shows `unreadable` and a notice instead of a guess), and the webhook
  path. `GET /settings` costs the same number of queries for 1, 3 or 12 connectors (a test counts them; a mutation reads per
  connector).
- **The webhook URL is a path.** `/hook/<name>`, never `<origin>/hook/<name>`: the server knows neither a configured public
  origin nor that the `Host` of a request is its own, and a link built from a `Host` header would reflect whatever the
  client sent. The page says to prefix the public address.
- **Setting a secret.** A password field per slot (`autocomplete="new-password"`, never pre-filled). The POST names `connector`
  and `slot`; only a slot of the connector's descriptor is accepted (anything else is 404: the screen cannot create a secret
  of an arbitrary name), the store name is `connector.secrets[slot]` else the slot, and the value goes to `secrets.set`.
  An empty value is "no change" (303, no write), a value over 4096 characters 400. The answer is a 303 to
  `/settings?ok=<name> saved`, or JSON `{ok, message}`; both carry the **name** only. Removing is its own POST and needs
  `confirm=yes`; a name that is shared by two connectors goes for both (the card shows the store name). A value is never
  trimmed or changed. The `.prev` of a rotation stays a command-line matter.
- **Every way the screen could leak a secret, and how each is closed.**
  1. *The save answer* (redirect, flash, JSON, error page): messages are built from the name and fixed words; an error from the
     store is passed through `redact` with the posted value and every value the store holds first.
  2. *The page*: a slot is `set`/`MISSING`, with no length, prefix, hash, count of characters or last-changed time; the password
     input has no `value`; the JSON mirrors the page.
  3. *Another route*: `/outbox`, the trace and the pages read nothing from the store, and a secret was never in an outbox row
     (section 3); the screen adds no new place where a value is held.
  4. *The trace*: `secret_set` and `secret_removed` keep the connector, the slot, the store name and the user id, never the
     body; the `denied` line keeps the path only.
  5. *The database and files*: the value is written only to `secrets.enc` (AES-256-GCM); a test scans every file of the app
     directory but the store for every window of 4 characters of the values it set.
  6. *A request body kept in memory or echoed*: it is read once, held in the request's closure and dropped; no handler puts
     it into a response, a log line or an exception message.
  7. *Send test*: runs the sandbox, which reads no secret; its output is the **shape** (names and types) of the answer, never
     a value, and an error is passed through `redact` with every stored value.
  8. *Caching*: the page is sent with `Cache-Control: no-store`; nothing secret is in it anyway.
  9. *A forged Host or a foreign page*: no origin is ever built from a header (the webhook is a path), and a POST from another
     origin is refused before the body is read.
  10. *A non-admin*: 403 before anything is read; the refusal lists nothing.
  Not closed by the screen: the browser (a password manager, a screen share, the request in the admin's network log) and a
  deployment without TLS in front of it, which exposes the value on the wire like any password form.
- **Send test.** Sandbox mode only (the mode the deploy file gives now); a live connector, a kind that has no descriptor or no
  sandbox operation is refused (400) and nothing runs. The call is the descriptor's `sandbox.test` (`{"op", "input"}`, new:
  checked at load, in the three shipped descriptors), else the **first operation with sandbox rules** with an empty input
  (defaults filled in; if that input is not valid the problems are shown as the failure). It goes through `deliverRow` with
  `mode: 'sandbox'` and a fixed key: no outbox row, no breaker event, no request, one `settings_test` trace line (connector,
  operation, status, code). The page shows the status, the code, the error if any and the shape.
- **Going live is not on the screen** (decision 6). Each card prints the exact command for the other mode,
  `node runtime/run.mjs <app.json> --connectors live NAME --confirm` (or `--connectors sandbox NAME`), and nothing a browser
  can post changes `deploy.json`.
- **Proof.** `tests/settings.test.mjs` (13 tests): the page and its JSON, the counts and the breaker, set/replace/empty/remove with
  a scan of every response, the redirect, the trace and every file for the values, an unreadable store, 403 for a customer and a
  guest on GET and all three POSTs (HTML and JSON), eight foreign-origin shapes on all three POSTs, methods and paths, a graph
  without roles and without connectors, a forged Host, the query count for 1, 3 and 12 connectors, send test (shape, the first-op
  fallback, an input that cannot be built, a failure status, no descriptor, `http`, nothing queued or sent) and refused in
  live, and the checker for `sandbox.test`. The acceptance check is the ninth of `apps/checkout`. 18 `C7:` mutations.
- **Not built.** Switching mode from the screen (by decision); rotation (`.prev`); a secret that is not a slot of a descriptor;
  an audit log beyond the trace line; rate limiting of the POSTs (the origin check and the admin gate come first); a
  configured public origin for the webhook URL.
