# Canopy connector library: design (v0.2.0 baseline)

**Status: design accepted (maintainer decisions, section 9). Stage C1 is done** (descriptor, checker,
engine, `connector.call`, `http` on it; see "C1 as built" at the end). C2 to C7 are next, in the order of
section 9.

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
- **Mode.** The mode is *not* in app.json (the same graph runs in dev and prod). It lives in the plain, diffable `<dir>/deploy.json`: `{connectors:{pay:{mode:"live", since, by}}}`. The default is `sandbox`. `live NAME` requires all `secret` slots to be present, `--confirm NAME`, and every live `base` to be https. It appends a row to a `_deploy_log` table. At boot and on each flush (stat mtime), a connector in live with a missing secret is marked *misconfigured*: deliveries fail with a clear error and **never fall back to sandbox silently**. The outbox row records `mode`, and `/outbox` shows it.
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
