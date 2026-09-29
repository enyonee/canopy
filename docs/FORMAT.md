# The app.json format (v2)

One JSON document is the whole application. Every effect is a node of a closed graph;
every computation is a pure expression. The runtime derives the schema, the screens,
the routes and the migrations from it. Nothing is written by hand besides this file.

Run: `node runtime/run.mjs apps/<name>/app.json --check` (validate) or `--port 8901` (serve).
The checker names the path, the problem and the way out for every error — fix the graph,
never work around the checker.

## Top-level nodes

| node | what |
|---|---|
| `app` | name, shown in the header |
| `task`, `note` | free text, ignored by the runtime |
| `theme` | `{ "background": <css colour>, "accent": <css colour> }` — all components use the accent |
| `home` | path the root redirects to, e.g. `"/Product"`, `"/page/about"`, `"/dashboard/sales"` |
| `data` | entities and their fields (below) |
| `seed` | starting rows, inserted once while the table is empty: `{ "Entity": [ {field: value} ] }`; a `file`/`image` field may be `{ "from": "seed/photo.jpg" }` (path relative to the app directory) — the runtime copies it into `files/` at boot |
| `identity` | one fake current user, no login: `{ "entity": "Profile", "defaults": {…} }` — cannot be combined with `roles` |
| `roles` | real login, sessions and a permission matrix (below) |
| `views` | must be `"auto"`: list, form and detail of every entity are derived |
| `override` | shapes the derived screens (below) |
| `lists` | named saved lists at `/list/<id>` |
| `dashboards` | cards and grouped tables at `/dashboard/<id>` |
| `pages` | static pages at `/page/<id>`, optionally with live `sections` (below) |
| `actions` | named step sequences: on a row (`in`) or global |
| `events` | steps that run on `Entity.created`/`.updated`/`.deleted`, on login, or on view (below) |
| `states` | status transitions per entity (below) |
| `schedule` | named timers the server runs on an interval (below) |
| `connectors` | endpoints the app may send to: `http`, `mail`, and any kind a connector descriptor defines (see Connector descriptors); never holds a secret |
| `rules` | checks and uniqueness (single field or a compound list) per entity |
| `allowDestructive` | `true` lets a migration drop columns the graph no longer declares |
| `plugins` | ES modules next to the app that add field kinds, blocks, transports and functions, and connector descriptors (`.json`) (see Plugins, Connector descriptors) |
| `search` | site-wide search: `{ "entities": ["Article", "Thread"], "title": "Search" }` → `/search?q=` (below) |

## Fields (`data`)

`"Entity": { "field": "<spec>" }`. Entity names are CapitalCase, field names camelCase.

| spec | meaning |
|---|---|
| `text!` | required text; `?` marks optional (default); `longtext` is multiline |
| `bool=false` | boolean with default; forms render a checkbox |
| `int=0` | integer |
| `money=9.99` | money: written and read as `12.34`, stored as integer minor units, rendered `12.34` |
| `date=today` | calendar date `YYYY-MM-DD`; `today` is a default |
| `time=now` | ISO timestamp; never on forms; `now` is a default |
| `enum[a,b,c]=a` | closed set with a default; renders as a select and as a filter |
| `ref:Entity!` | reference; renders as a select of the target's label (its first text field) |
| `file` | an uploaded file; forms become multipart; the value renders as a download link. An empty upload leaves an optional field unset (or unchanged on edit, exactly like a blank password); a **required** file/image field with an empty upload is a validation error ("… is required"), including on edit — leaving it blank never silently keeps a required file |
| `image` | an uploaded image; rendered inline as a thumbnail linking to the file |
| `password!` | secret; stored as a salted hash, never rendered, blank on edit keeps the old one |
| `money := <expression>` | derived field: computed on every read, never stored, never on forms |

A derived field may be `int`, `money`, `bool`, `text`, `date` or `time`. Its expression
is checked statically against the entity; cycles are refused.

The row's label (in links, selects and titles) is its first `text` field, else `#id`.

## Expressions

Used in derived fields, `rules[].check`, and inside steps as `"= <expression>"`.

- Arithmetic `+ - * /`, comparisons `= != < <= > >=`, `and or not`, parentheses.
- Fields of the current row by name: `qty * price`. One hop through a reference: `customer.discount`.
- `id`: the current row's own id (a number, read-only) — a reference code like `concat('BK-', id)` is derivable.
- Aggregates over rows that reference this one: `sum(OrderItem: qty * price)`, `count(Activity)`,
  `count(Activity: not done)`, `avg/min/max(Child: field)`; `min`/`max` also over dates. The child must
  have exactly one `ref` to this entity, or name it: `count(Pair.first)`. Inside the body `row.x` is
  the outer row — a correlated aggregate. An entity with no reference to this one aggregates over all
  its rows, so siblings are reachable: `count(Booking: car = row.car and start <= row.end and end >= row.start)`.
- Functions: `if(cond, a, b)`, `days(later, earlier)` (calendar days), `hours(later, earlier)` and
  `minutes(later, earlier)` (real elapsed time over full timestamps, not just calendar days),
  `addDays(date, n)`, `round(x, n)`, `abs(x)`, `min(a, b)`, `max(a, b)`, `coalesce(a, b, …)`,
  `len(text)`, `lower(text)`, `upper(text)`, `concat(a, b, …)`.
- Clock: `today` (date), `now` (time).
- Money is in major units inside expressions (`price > 100` means 100.00). `+`, `-`, `*`, `sum` and `avg`
  are exact to 6 decimals: `3 * 0.1` is `0.3`, so `qty * price > 0.3` is false for 3 and 0.1. Division
  is the exception: a quotient is a fraction, rounded only by the field or `round(x, n)` that stores it.
- Null propagates through arithmetic; comparisons with null are false except `= null` / `!= null`.

Inside steps, names are `row.<field>`, `each.<field>`, `found.<field>`, `picked.<field>`,
`values.<name>` (the submitted form), `me`, `created`, `delivery`, `now`, `today`; a bare
name is a field of the current row.

## Screens (`override`)

Keys are `"Entity.list"`, `"Entity.form"`, `"Entity.detail"`.

`Entity.list`:
- `title`, `intro`, `hidden` (out of the menu), `create: false` (no add button), `createTitle`
- `columns`: field names (derived allowed), `"id"` allowed
- `search`: fields the search box matches (stored text fields)
- `filters`: `[ { "name": "Status", "field": "status" } ]` — ref, enum and bool fields get their
  options automatically; `{ "field": "createdAt", "range": true }` adds a from/to form for date,
  time, int or money fields (query params `<field>_from`, `<field>_to`)
- `where`: a fixed filter, e.g. `{ "active": 1 }` or `{ "id": "@me" }`; comparisons `{ "field": { "gte": …, "lte": …, "gt": …, "lt": …, "ne": …, "in": [...], "like": … } }`; `"@me"`, `"@today"` allowed.
  The field itself set to `null` is `IS NULL`; `{ "ne": null }` is `IS NOT NULL` — the one place `null`
  is meaningful in a comparison; the checker refuses a literal `null` on every other comparison
  (`{ "gte": null }`, …), which is never true and was silently ignored before.
- `sort`: `{ "field": "createdAt", "dir": "desc" }` — the default; every column header sorts (`?sort=&dir=`)
- `pageSize`: rows per page (default 50); `?page=N`; the row count and a CSV link (`/Entity.csv`, same query) are under every list
- `rowActions`: any of `"view"`, `"edit"`, `"delete"`, `"go:<transition>"`, `"<action name>"` (an action with `"in"` this entity); default `["edit", "delete"]`
- `labels`: `{ "done": ["Open", "Done"] }` captions for a boolean

`Entity.form`:
- `title`, `intro`, `submit` (button caption), `fields` (stored fields to show), `fill` (values set silently on create, e.g. `{ "author": "@me" }`)
- `confirm` (flash after create), `after` (path after create, `{id}`, `{created}` or `{field}` substituted), `afterEdit`, `confirmEdit` —
  `confirm`/`confirmEdit` interpolate `{row.field}` (the just-written row) and `{id}`/`{created}`, exactly like an action's `confirm`
- the status field of an entity with `states` is never on the form; the fillable `own` field (below) of the viewer's role is never on the form — a second-or-later own field (e.g. a message's `recipient` in `own: ["sender", "recipient"]`) is an ordinary field a submit may set
- `byRole`: `{ "admin": { "fields": [...] } }` — that role's field list entirely replaces `fields` above, for both rendering and writability (a field left out is not writable by that role, even by editing the request directly); a role with no entry keeps the default `fields`

`Entity.detail`:
- `fields` (which to show; derived allowed), `labels`
- `actions`: row actions shown as buttons
- `private`: `{ "holeCards": "player" }` — that field is shown only to the user `player` (a direct
  `ref:<roles entity>` field of this same entity) names, plus any admin; anyone else reads it as
  hidden (`"Hidden"`/`null`/blank, depending on output). One predicate (not a per-view setting)
  covers every place the field could otherwise leak: this entity's own detail and list pages
  (HTML), its JSON answers, and its CSV export. A related child table, a saved list, a page
  section and search results all read the same field the same way, so the same redaction applies
  there too — `private` is declared once, on `.detail`, and enforced wherever the field is read.
- `related`: `[ { "entity": "OrderItem", "via": "order", "title": "Items", "columns": [...], "form": ["qty"] | false, "fill": {…}, "submit": "Add", "confirm": "…", "rowActions": ["edit", "delete"] } ]` — a child table with an inline add form; `fill` resolves `@row.*` against the **parent** row (the one the detail page is showing), unlike `Entity.form`'s top-level `fill`, which runs before any row of the new entity exists and has no `@row`

## Lists, dashboards, pages

Saved lists and dashboards export too: `/list/<id>.csv`, `/dashboard/<id>.csv` (cards and grouped tables as rows).

`lists`: `{ "id": "cart", "entity": "Order", "title": "Cart", "where": { "customer": "@me", "status": "cart" }, "columns": [...], "rowActions": [...], "sort": {…}, "search": [...], "create": true, "roles": ["customer"], "hidden": true }`.

`dashboards`: `{ "id": "sales", "title": "Sales", "intro": "…", "roles": ["admin"], "refresh": 30, "period": { "Order": "createdAt" }, "cards": [...], "tables": [...], "charts": [...] }`
- `period` maps entities to their date/time field and adds a from/to form; every card, table and chart on those entities is narrowed
- card: `{ "title": "Revenue", "entity": "Order", "fn": "sum", "field": "total", "where": {…} }` — `fn` is `count` (default), `sum`, `avg`, `min`, `max`; money renders as money
- table: `{ "title": "By status", "entity": "Order", "groupBy": "status", "groupTitle": "Status", "groupUnit": "month", "where": {…}, "metrics": [ { "fn": "count", "as": "n", "title": "Orders" }, { "fn": "sum", "field": "total", "as": "revenue", "title": "Total" } ], "sort": { "field": "revenue", "dir": "desc" }, "limit": 10 }` — `groupUnit` (`day`, `month`, `year`) buckets a date/time `groupBy`; `where` may use `"@me"`
- chart: `{ "title": "By status", "entity": "Order", "type": "bar"|"line"|"pie", "groupBy": "status", "groupUnit"?: "month", "metric": { "fn": "sum", "field": "total" }, "where"?: {…}, "limit"?: 10, "sort"?: { "field": "v", "dir": "desc" } }` —
  one metric, computed by the same `store.aggregate` a table uses (`fn` is `count`/`sum`/`avg`/`min`/`max`; `field` required unless `count`;
  `sort.field` is `"grp"` or `"v"`, the chart's only metric). Rendered as an inline accessible SVG
  (`<svg role="img" aria-label="…">` + `<title>`, bars/points/slices in the theme accent) immediately followed by
  `<table class="chart-data">` with the same numbers, so a check or a screen reader reads values without decoding
  the SVG — that table is also the chart's row in a CSV/JSON export (below).

`pages`: `{ "id": "about", "title": "About", "heading": "…", "body": ["paragraph", …], "links": [ { "label": "Shop", "href": "/Product" } ], "actions": ["<global action>"], "roles": [...], "widget": {…}, "refresh": 30, "sections": [...] }`.

`sections` embeds live data inside an otherwise-static page — one of, per entry:
- `{ "list": "<saved list id>", "limit"?: 5 }` — a read-only preview table of that saved list, read with the
  viewer's own permissions (own-scoping and `roles` both apply, exactly like `/list/<id>`); `limit` caps the
  rows shown (unlimited without it).
- `{ "form": "Entity" }` — that entity's create form, posting to the normal `POST /Entity` route (the same
  validation, `fill` and permission check a real `/Entity/new` gets); the viewer needs `create` on it.
- `{ "text": "…" }` — a plain paragraph.

`refresh` (pages and dashboards, seconds, a positive integer): renders `<meta http-equiv="refresh" content="N">` —
the page reloads itself every `N` seconds. JSON mode (below) is the real-time path for a widget that wants to
poll or push without a full reload; `refresh` is for the plain scaffold page.

## Actions, steps, blocks

`actions`: `{ "name": "addToCart", "in": "Product", "title": "Add to cart", "by": ["customer"], "after": "/list/cart", "confirm": "{row.name} added", "do": [ <step>… ] }`.
An action with `in` runs on a row (`POST /Entity/:id/action/<name>`, offered through `rowActions` or `detail.actions`); without `in` it is global (`POST /action/<name>`, offered through `pages[].actions`).
`by` names the roles that may run it (still scoped by any `own` grant on the entity, unless the action's
`do:<name>` is itself in that grant's `all`); without `by`, the role needs `do:<name>` (or `do:*`) on the
entity (global actions: on `"*"`). A row's action button uses the exact same predicate as the `POST` handler
that runs it — it is never offered where the server would then refuse, and never hidden where the server
would allow it.
`confirm` interpolates `{row.field}`, `{found.field}`, `{created}`, `{made}`, `{delivery}`, `{me}`; money formats as `12.34`.
`fields`: an input form on the button, like a transition's own `fields` — a row action's are real, stored, typed
fields of `in` (required, validated the same way); a global action has no entity to type them against, so its
are plain required text inputs (still reachable as `@values.<name>` in `do`). Offered as a real form (rendered
next to the row's transition forms, or on the page for a global action); a bare row-action or list button is
never given one (same as a transition with `fields` in a list row).

Every step is `{ "block": "<name>", …parameters }`. Values may be literals, `"@row.field"`, `"@each.field"`, `"@found.id"`, `"@picked.field"`, `"@values.name"`, `"@me"`, `"@created"`, `"@now"`, `"@today"`, or `"= <expression>"`.

| block | parameters | does |
|---|---|---|
| `db.create` | — | creates a row of the action entity from the submitted values; fires its `created` event |
| `db.createRow` | `entity`, `values` | creates a row of `entity` from literal/resolved values; `@created` is its id; fires `entity`'s `created` event, like any other create |
| `db.update` | `set` | updates the current row |
| `db.set` | `entity`, `id`, `set` | updates an arbitrary row named by `entity` + `id` (e.g. `@found.id`, `@each.id`, `@row.ref`) — like `db.update`, but not limited to the current row |
| `db.delete` | — | deletes the current row |
| `db.toggle` | `field` | flips a boolean of the current row |
| `db.adjust` | `field`, `by`, optional `entity` + `id`, `min`, `message` | adds `by` to an int/money field (stock, balances); refuses below `min` |
| `db.ensure` | `entity`, `where`, optional `values` | finds the first row matching `where` or creates it; `@found` is the row, `@made` says which; a made row fires `entity`'s `created` event |
| `db.each` | `from`, optional `where`, `do` | runs the nested steps once per row; the row is `@each` |
| `random.pick` | `from`, optional `weight` | picks a random row; `@picked` |
| `check.matchRef` | `ref`, `field`, `against`, `into` | compares a field with one on a referenced row, writes 1/0 |
| `http.send` | `connector`, `body`, optional `path` | queues a JSON request to an http connector; delivered after commit |
| `connector.send` | `connector`, `body` | queues to any connector; its kind picks the transport (plugin transports) |
| `connector.call` | `connector`, `op`, `input`, optional `ref` | calls operation `op` of a connector whose kind has a descriptor; `input` (an object; `@row.f` and `= expr` allowed) is checked against the operation's schema when the step runs, so a bad call refuses the action and queues nothing; delivered after commit |
| `mail.send` | `connector`, `to`, `subject`, optional `text` | queues a letter; `{row.field}` placeholders in subject/text |

Steps run inside one transaction; a block that refuses (not enough stock, no such row) rolls
everything back and answers 400 with its message. Outgoing effects wait in the outbox and are
delivered after the commit; `/outbox` shows every delivery with its status and a retry button. A row queued by `connector.call` also records `op`, the answer and its mapped `result`.

Delivery statuses: `queued` (waiting, possibly for its `nextAttemptAt`) → `sending` (claimed by one
flush, request in flight) → `sent`, `failed` or `unknown`. `failed` and `unknown` get a retry button
(it starts the row over: `queued`, attempts 0, no wait); `unknown` also gets "mark sent". A row is
claimed by one atomic update before it is delivered, so overlapping flushes (two requests
committing together, later several instances) never deliver one row twice. A row that stays in
`sending` for longer than the 60 s lease (the process died mid-delivery) is claimed again. So
delivery is exactly-once, except across a crash, where it is at-least-once: a connector should
send an idempotency key (the outbox row id, `@delivery`) that its receiver can deduplicate on.
A delivery that outlives its lease and finds the row re-claimed does not write its result: the
newer claim owns the row.

**Retries.** What an attempt came to decides the row (`runtime/connectors/backoff.mjs`): a 2xx is
`sent`; a network error, a timeout, `429` and `5xx` are retryable; any other answer (`4xx`) is final
and `failed`. Only an operation with `idempotent: true` is retried after an answer or after a request
that may have arrived. A non-idempotent operation that got a `5xx`/`429` is `failed` (the provider
answered); one that got **no answer** (a timeout, a connection reset: the request may have landed) is
`unknown`, never retried by the runtime, and waits for an operator ("mark sent" if the effect happened,
"retry" if not). A request that certainly never left (DNS, connection refused) is retried whatever the
operation. A retry puts the row back to `queued` with `nextAttemptAt` (epoch ms) `= now + min(capMs,
baseMs · 2^(attempts−1))`, less a deterministic jitter (up to `jitter` of it, from a hash of the row's
idempotency key and the attempt, never random), and never less than the answer's `Retry-After` (itself
capped at `capMs`). After `max` attempts the row is `failed`. Defaults: `max` 5 (the first attempt
counts), `baseMs` 1000, `capMs` 60000, `jitter` 0.2. A background flusher (every 5 s, and once at the
earliest `nextAttemptAt`) delivers due retries without a request; it is off under `AG_NO_TIMERS`, where
only a request or the retry button delivers.

The **idempotency key** of a row (`idemKey`, 32 hex digits: a hash of the app, connector, row id and
creation time) is computed once when the row is queued and never changes; every retry and a delivery
after a lease takeover send the same one, in the header a descriptor names under `idempotency`.

**Circuit breaker.** Per connector and mode (`_breaker`): after `threshold` consecutive retryable
failures (default 5; a `4xx` never counts, any answer that is not retryable resets the count) the breaker
opens for `cooldownMs` (30000). While it is open the flusher does not claim the connector's rows; it
moves their `nextAttemptAt` to the end of the cooldown and counts no attempt. After the cooldown exactly
one call is let through (an atomic claim, the probe): if it succeeds the breaker closes, if it fails the
breaker reopens with the cooldown doubled up to `maxCooldownMs` (600000). `/outbox` lists the state of each
breaker.

A row that `db.create`/`db.createRow`/`db.ensure` makes fires its entity's own `created` event,
exactly like an HTTP create — so `events` sees every row however it was made, including one a
`created` event's own steps go on to make, of the same or another entity. A chain of these
(`A.created` makes a `B`, `B.created` makes an `A`, …) is bounded: past a fixed nesting depth the
whole action refuses with a named error instead of recursing forever. A `created` event that
unconditionally makes another row of its own entity always hits that limit; one that `db.ensure`s a
row that then already exists (a fixed "default row" pattern) settles after one extra round and never
comes close to it.

`events`: `{ "on": "Lead.created", "do": [ <step>… ] }` — `created`, `updated` (after a form edit), `deleted` (the
row is `@row` as it was); `{ "on": "User.login", "do": [...] }` (the roles entity only; row = the user who just
signed in); `{ "on": "Article.viewed", "do": [...] }` (any entity; row = the row a `GET` detail just read — a
**write on read**, run inside a transaction like any other event, so its own steps commit or roll back
together). Both fire best-effort: a failing `login`/`viewed` event is traced, never surfaced — a broken hook
must not lock anyone out of signing in or of viewing a page.

## States

```json
"states": { "Order": { "field": "status", "transitions": [
  { "name": "place", "from": ["cart"], "to": "placed", "title": "Place order", "fields": ["address"],
    "by": ["customer"], "confirm": "Order #{row.id} placed", "after": "/Order/{id}", "do": [ <step>… ] } ] } }
```
`field` is an enum with a default (the initial status); every status must be reachable.
`from` is a list of statuses or `"*"`. `fields` are asked for on the transition form and are
required. `by` restricts by role; otherwise the role needs `go:<name>` or `go:*`.
The transition is offered on the detail page (and in `rowActions` as `"go:<name>"`) only while the
status is in `from`; `POST /Entity/:id/go/<name>` from another status answers 409.

## Schedule

```json
"schedule": [ { "name": "tick", "every": "5m", "note": "…", "do": [ <step>… ] } ]
```
`every` is `<n>s|m|h|d` (e.g. `"30s"`, `"5m"`, `"1h"`, `"1d"`). The server runs each declared schedule on its
own timer, inside a transaction just like a global action — the same interpreter, no row, no submitted values,
effects through the outbox. `POST /schedule/<name>/run` runs one immediately: allowed for an operator (an
admin role, or anyone at all when the app has no `/roles`) — the same rule `/outbox` already uses — so a check
can trigger a schedule deterministically instead of waiting on the clock. Every run, timer or requested, is one
trace entry (`{ "kind": "schedule", "name", "manual" }`). Timers are unref'd (never keep the process alive by
themselves) and are stopped when the server closes. Set `AG_NO_TIMERS=1` to disable the automatic timers
entirely — `verify/run.mjs` sets it, so an app's checks control every schedule run by hand.

## Roles

```json
"roles": { "entity": "User", "login": "email", "password": "password", "role": "role",
  "register": "customer", "anonymous": "guest",
  "can": { "admin": "*",
           "customer": { "Product": ["view", "do:addToCart"],
                          "Order": { "own": "customer", "can": ["view", "create", "go:pay"], "all": ["view"] },
                          "*": ["do:ping"] },
           "guest": { "Product": ["view"] } } }
```
- `entity` has a `text` login, a `password` field and an `enum` role field; seed users with plain passwords.
- `register` (optional): the role a visitor gets from `/register`; without it there is no self-registration.
- `anonymous` (optional): the role of a visitor without a session; without it every page asks for login.
- Operations: `view`, `create`, `edit`, `delete`, `go:<transition>`/`go:*`, `do:<action>`/`do:*`, `*`; entity `"*"` is the fallback.
- `own`: scopes the operations in `can` to rows the role owns — **not** all-or-nothing (below). Fired from the
  session on create, into the field named by `own` (see "the fillable field", below), and checked on every
  read/write of an owned operation.
  - a single field: `"own": "author"` (a `ref:<user entity>` field of this entity) — owner if it equals the session user.
  - several fields: `"own": ["sender", "recipient"]` — owner if **any** of them matches (each still a `ref:<user
    entity>` field of this entity).
  - a one-hop path: `"own": "profile.user"` — this entity has a `ref:<X>` field (`profile`); `X` has the
    `ref:<user entity>` field (`user`) that names the owner. Only one hop; the checker rejects `"a.b.c"`.
  - **the fillable field**: create only ever silently fills the *first* name in `own`, and only when it is a
    direct field (not a one-hop) — `["sender", "recipient"]` fills `sender`; a bare one-hop `own` fills nothing
    (the graph must collect it some other way, e.g. through `Entity.form`'s `fill`).
  - `all`: operations that apply to **every** row regardless of `own` — `{"own": "customer", "can": ["create",
    "go:pay"], "all": ["view"]}` means a customer only creates and pays for their own orders, but may `view`
    any order. Without `all`, every operation in `can` is owned-only (the old all-or-nothing behaviour is
    `can` with no `all`). A saved list, dashboard card/table/chart or related child table still narrows to
    owned rows only for an operation that is actually owned — a `view` granted through `all` is never narrowed.
- Lists, dashboards and pages take `"roles": [...]`; the menu shows only what the viewer may open.
- Routes: `/login`, `/register`, `POST /logout`. A signed-in user is shown in the header. A denied GET redirects to `/login?next=…` when anonymous, else 403.

## Connectors, rules

```json
"connectors": { "crmHook": { "kind": "http", "url": "http://127.0.0.1:8999/hooks/crm", "method": "POST", "headers": {…} },
                "mail": { "kind": "mail", "from": "shop@example.test" } }
"rules": { "OrderItem": [ { "check": "qty > 0", "message": "Quantity must be at least 1" } ],
           "User": [ { "unique": "email", "message": "…" } ],
           "Follow": [ { "unique": ["follower", "category"], "message": "Already following this category" } ] }
```
Rules run on **every** write, not only an HTTP create/edit: the guard lives in the store itself
(`Store#insert`/`Store#update`, the one place every write lands), so a block (`db.create`,
`db.createRow`, `db.update`, `db.set`, `db.adjust`, `db.toggle`, `db.ensure`, a plugin's own
`store.insert`/`store.update`) and a seed row at boot meet the same rules an HTTP form does —
none of them has a path around it. A form still re-renders with the message (400); a block
refuses the whole action the same way an unmet `db.adjust` floor does (rollback, 400, the
rule's message); a seed row that violates a rule is a boot error naming the entity, the row and
the rule, served the same way a statically invalid graph is — not a crash.
`unique` may name a single field or, for a compound ("unique together") constraint, an array of fields — the
combination must be unique, not each field alone; on an edit that only submits one of the fields, the other's
existing stored value is used for the check.
Mail is recorded in the outbox (the stand has no SMTP); http is really sent.

No secret goes in `app.json`: a string under a key like `key`, `token`, `secret`, `password` or
`authorization`, or one shaped like `sk_…`, `Bearer …` or a JWT, is an error, and so is a
credential or `{secret.*}` in a connector's `url` (the url is what `/outbox` and the trace show).
Write `{secret.name}` where a value is needed (header or body): it is read from the secret store when
the request is sent — never when the row is queued, and never stored. A connector may map a slot to a
differently named secret: `"secrets": {"apiKey": "stripe_key"}` (names only, never values); without a mapping
the slot is the name. A secret the store lacks fails the delivery for good (not retried, and the provider's
breaker is not touched). See "Secrets and modes" below.

### Connector descriptors

A connector kind beyond `http` and `mail` is a **descriptor**: JSON data, listed like a plugin
(`"plugins": ["../../connectors/stripe/descriptor.json"]`); its `name` becomes the connector `kind`.

```json
{ "descriptor": 1, "name": "pay", "timeoutMs": 5000,
  "config": { "type": "object", "required": ["host"], "properties": { "host": { "type": "string", "pattern": "^https://" } } },
  "operations": { "charge": {
      "idempotent": false,
      "input":  { "type": "object", "required": ["amount"], "properties": { "amount": { "type": "integer", "minimum": 1 },
                  "currency": { "type": "string", "default": "USD", "pattern": "^[A-Z]{3}$" } } },
      "request": { "method": "POST", "url": "{config.host}/charges", "body": { "$": "input" } },
      "output": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } },
      "result": { "id": "$.id" } } } }
```
```json
"connectors": { "pay": { "kind": "pay", "host": "https://pay.example" } }
{ "block": "connector.call", "connector": "pay", "op": "charge", "input": { "amount": "= total * 100" } }
```

- A connector's keys are validated against the descriptor's `config` schema (closed unless it says
  `additionalProperties: true`). `input` is validated against the operation's schema: unknown keys,
  missing `required`, wrong types are refused. The checker judges literal values and the type of a
  `@row.field` (`money` is a number, `int` an integer or number, `ref` an integer, text/enum/date a
  string, `bool` a boolean); values only known at run time are judged when the step runs.
- Schemas: `type` (`object array string integer number boolean null`), `properties`, `required`,
  `additionalProperties` (false unless declared, once `properties` is given), `items`, `enum`, `format`
  (`email date-time uri`), `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`; annotations `default`
  (fills a missing input), `title`, `description`, `message`, `hint`. Any other keyword is an error.
- Templates: `{config.x}`, `{input.x}`, `{secret.x}`, `{base}` in strings; `{"$": "input.x"}` for a whole
  value of any type; `"..."` spreads an object. `{secret.*}` never in `url`. No expressions, no conditionals.
- **URLs are safe by construction.** In a `url` template every `{input.*}` (and `{key}`) is
  percent-encoded whole (`encodeURIComponent`): `/`, `?`, `#`, `%`, `..` sequences and non-ASCII cannot leave
  their segment or add a query. `{config.*}`, `{base}` and literals are the operator's and stay raw. The
  origin (scheme, host, port) may come only from those: an `{input.*}` or `{key}` before the first `/` after
  the host (`https://{input.host}/x`, `{base}{input.id}`) is a descriptor error. Header values that hold a
  CR or LF (from input or config) fail the delivery.
- An operation says `idempotent: true|false` (no default). `timeoutMs` is at most 30000 (half the lease); a
  connector's own `timeout` may not raise it past that either. `result` maps names
  to `$.a.b[0]` paths of the answer and needs an `output` schema.
- Reliability keys of a descriptor (top level, all optional; see "Retries" above): `retry`
  `{ max 1-20, baseMs, capMs, jitter 0-1 }` and `breaker` `{ threshold, cooldownMs, maxCooldownMs }` override the
  defaults (`capMs` may not be below `baseMs`, nor `maxCooldownMs` below `cooldownMs`); `idempotency`
  `{ "header": "Idempotency-Key" }` sends the row's key in that request header. `{key}` in a template is
  still an error: the header is the only way the key leaves.
- **Modes.** `"modes": ["sandbox", "live"]` (top level, optional) lists the modes the kind may run in; the
  first is the default. A descriptor that says nothing is live only, as before; built-in `http` is live only and
  `mail` is sandbox only, so no existing app needs a deploy step. A descriptor that lists `sandbox` needs a
  `"sandbox"` block with rules for every operation:
  `"sandbox": {"operations": {"charge": [ {"when": {"input.amount": {"gt": 999900}}, "status": 402, "body": {...}},
  {"status": 200, "body": {"id": "sbx_{key}"}} ]}}`. The first rule whose `when` holds answers (no `when` always
  holds); `when` maps `input.<name>` to a value (equal) or to comparisons `eq ne gt gte lt lte in present`;
  `status` defaults to 200, `headers` (strings) are the answer's (`Retry-After` works), `body` is a template over
  `{input.x}`, `{config.x}` and `{key}` (the row's idempotency key: the same fake id on every retry). The answer
  goes through the same mapping as a real one (`output`, `result`, `drift`, retry classification). No rule
  matching is a failed delivery. Nothing is sent and no secret is read in sandbox mode.
- The outbox row of a call has `op`, the completed input as `payload`, and after delivery `response` (the
  answer text, up to 16 KB), `result` and `drift`. An answer that does not fit `output` sets `drift` to 1 and
  writes `contract_drift` to the trace; the row stays `sent` because the effect happened.
- `http` is the built-in descriptor of today's connector: `"url"` (required), `"method"` (POST unless
  set), `"headers"` merged over the JSON content type, `"timeout"` (3000 ms unless set). Its one
  operation `send` takes `body`, so `connector.call { connector, op: "send", input: { body } }`
  is `http.send` without a `path` (data may not extend the url). Plugin code (`.mjs`) and descriptors (`.json`) coexist in one `plugins` list.

### Secrets and modes

The secret store is the file `secrets.enc` beside the database (and `secrets.key`, mode 0600, made by the first
`--secrets set`; or the environment variable `CANOPY_MASTER_KEY`, 32 bytes as base64, which takes precedence and
is what a hosted deployment should use). It is one AES-256-GCM blob under a key derived with HKDF, so even the
names are hidden; a wrong key or a changed byte fails closed with a message, and the app's name is part of what
is authenticated. `name.prev` holds the value before a rotation: a consumer that accepts a list (a verifier)
gets `[name, name.prev]`, a request is signed with `name` alone. A secret's value is masked (as written, as
JSON text and URL-encoded) in every answer, error and trace line of a delivery, so it is not in the outbox, the
trace or any screen.

The mode of each connector is not in `app.json` (the same graph runs on a laptop and in production). It is in
`deploy.json` beside the database, `{"connectors": {"pay": "live"}}`, and only the command line writes it; absent
means each kind's first mode. It is read afresh on every delivery, so a switch takes effect without a restart,
and a malformed file stops the app at boot instead of guessing a mode. A mode the kind does not offer fails the
delivery; nothing ever falls back to sandbox or to live silently. The breaker of a connector is kept per mode.

```bash
node runtime/run.mjs app.json --connectors status               # each connector, its mode, its secrets: set / MISSING
echo -n "$KEY" | node runtime/run.mjs app.json --secrets set stripe_key   # the value comes from stdin, never argv
node runtime/run.mjs app.json --secrets list                    # names only
node runtime/run.mjs app.json --secrets rm stripe_key
node runtime/run.mjs app.json --connectors live pay --confirm   # refused without --confirm, or while a secret
                                                                # its live requests read is not in the store
node runtime/run.mjs app.json --connectors sandbox pay
```

`/outbox` lists each connector with the mode it runs in and the modes it offers.

## Search

```json
"search": { "entities": ["Article", "Thread"], "title": "Search" }
```
`/search?q=` renders one result section per named entity, using that entity's own `Entity.list`'s `search`
fields and the viewer's permissions (own-scoping applies exactly as it does on that entity's own list) — no
query, no sections. A search box appears in the page header whenever `/search` is declared, for every viewer
(each section still narrows or disappears by permission). `title` (optional) captions both the header box and
the `/search` page itself.

## Routes the runtime serves

`/` → home · `/Entity` list (`?q=`, `?<filter field>=`, `?<field>_from=&<field>_to=`) · `/Entity/new` · `POST /Entity` · `/Entity/:id` detail · `/Entity/:id/edit` · `POST /Entity/:id` edit · `POST /Entity/:id/delete` · `POST /Entity/:id/action/<name>` · `POST /Entity/:id/go/<transition>` · `POST /Entity/:id/add/<Child>` (related form) · `/list/<id>` · `/dashboard/<id>` (`?from=&to=`) · `/page/<id>` · `/search?q=` · `POST /action/<name>` · `POST /schedule/<name>/run` · `/outbox`, `POST /outbox/:id/retry`, `POST /outbox/:id/sent` (mark an `unknown` delivery as sent) · `/file/Entity/:id/<field>` · `/widget/<name>.mjs`, `/widget/_api.mjs` · `/login`, `/register`, `POST /logout`.

Every successful POST answers 303 to a page with `?ok=<flash>`; validation failures answer 400 with the form and the messages; refusals 403; a transition from the wrong status 409.

## JSON answers

Any of the routes above that reads or writes an entity answers JSON instead of HTML when the request carries
`accept: application/json` — one code path decides everything (permission checks, own scoping, validation,
effects); the Accept header only picks the last step, how the same result is written down.

- GET `/Entity`, `/list/<id>` → `{ "rows": [...], "total", "page", "pages" }`; GET `/Entity/:id` → the row itself,
  flat (`{ "id", …fields }`). GET `/dashboard/<id>` → `{ "cards": [ { "title", "value" } ], "tables": [ { "title", "rows" } ], "charts": [ { "title", "type", "rows" } ] }` —
  the same aggregates the HTML/CSV views compute. GET `/search?q=` → `{ "results": [ { "entity", "rows" } ] }`,
  one entry per `/search` entity the viewer may see (empty `rows` without a `q`).
- A row's JSON always drops secret fields (`password`), always includes derived fields, and reads money as a
  major-unit number (`12.34`, not `1234`); own-scoping and every permission check are identical to the HTML path.
- POST (create, edit, delete, an action, a transition, a related add, a global action) →
  `{ "ok": true, "id"?, "created"?, "flash", "row"? }` on success (`id`/`created`/`row` are present where the
  HTML path's redirect target and confirmation would name them — a delete or a global action has no `row`) or
  `{ "ok": false, "status", "errors": [...] }` on failure, with the exact status code the HTML path uses (400
  validation, 403 refusal, 404 unknown, 409 wrong status).

## Client widgets

A widget is presentation + input only: it renders state it reads and sends intents to the graph's own
actions/transitions; it never writes storage itself (game rules, if any, live in a plugin block on the server,
which stays the authority — see `ttt.move` in `apps/tictactoe` for the whole path end to end).

A plugin registers widgets in a fifth registry table, next to fields/blocks/transports/functions:
```js
widgets: { chess: { summary: 'a chess board', client: './chess.client.mjs', props: ['fen'], check(node, h) {…} } }
```
`client` is a path to the browser module, relative to the app directory (like a plugin path) — kept out of
`plugins/`, which the registry-contract test blindly imports as server-side code; a browser file belongs next to
the app instead (or in its own directory, just not inside `plugins/`). `props` names the keys the widget node
must supply (missing one is a checker error naming the widget and the prop); `check(node, h)` is the same shape
a block's `check(step, h)` gets, for anything `props` alone can't express.

Attach a widget with `"widget": { "use": "chess", …props }` on `pages[].widget` (no row) or
`"Entity.detail".widget` (given the row). The checker only knows what the widget declared: unknown widget or a
missing required prop is an error with a hint, same as everywhere else.

A prop's value may be `"@row.field"` — resolved server-side against the row (never on `pages[].widget`, which
has none), from the same JSON shape a JSON GET of that row returns (secrets dropped, derived fields included).
`data-props` carries the resolved value, not the literal string; the checker rejects `@row.*` on a widget with
no row, and a field name it does not recognise (or that is secret) on one that does.

Rendered as:
```html
<div class="widget" data-widget="chess" data-props='{"fen":"…"}' data-row='{"id":3,…}'>
  <noscript>This page needs JavaScript to show the chess widget.</noscript>
</div>
<script type="module" src="/widget/chess.mjs"></script>
```
`data-row` is the same JSON shape a JSON GET of that row returns (secrets dropped, derived fields included);
absent on a page widget. The server serves the declared `client` file at `/widget/<name>.mjs`
(`content-type: text/javascript`) — only a file a loaded plugin actually declared; the requested name is looked
up in the registry, never turned into a filesystem path, so there is no traversal.

Client contract: the module's default export is `mount(el, { props, row, api })`. `runtime/client/api.mjs`, a
tiny shared helper served at `/widget/_api.mjs`, gives every widget module:
- `api.get(path)` — fetches JSON from any route above (sets `accept: application/json`).
- `api.post(path, body)` — posts `body` form-encoded (exactly what every `<form>` on the scaffold already posts)
  and reads the JSON answer back.
- `mountWidgets(name, mount)` — finds every `[data-widget="name"]` element the server rendered and calls
  `mount(el, { props, row, api })` on each; a widget module's own last line is typically
  `mountWidgets('chess', mount)`.

## Reading the HTML in checks

- Column headers are sort links: `<th><a href="…?sort=name&dir=asc">Name</a></th>`, the active column carries ` ▲`/` ▼`; match them tolerantly, e.g. `/<th>(?:<a[^>]*>)?Name/`.
- Table rows are `<tr class="…">…</tr>`; a cell is `<td>…</td>`; a reference renders `<a href="/Entity/3">label</a>`; money `12.50`; a status `<span class="status">Placed</span>` (capitalised); booleans `Yes`/`No` or the declared labels.
- Detail pages are `<tr><th>Field Name</th><td>value</td></tr>`; field names are split on capitals (`createdAt` → `Created At`).
- The flash is `<p class="flash">…</p>`; dashboard cards are `<div class="metric"><b>value</b>Title</div>`.
- Forms: `<input … name="field">`, `<select name="field">`, buttons `<button type="submit">Caption</button>`; transition forms post to `/Entity/:id/go/<name>`.

## Plugins

Classic code lives next to the application, never inside `app.json`. A plugin is an ES module
listed under `"plugins": ["./plugins/loyalty.mjs"]` (paths relative to the app directory) whose
default export registers entries in one or more of the five registries, with the same contracts
the built-ins use. Node kinds (`roles`, `states`, …) are not extensible: they are the format.

```js
export default {
  fields:     { percent: { sql: 'INTEGER', exprKind: 'number', numeric: true, derivable: true,
                           def(f), coerce(raw), validate(v, f), toExpr?(v), fromExpr?(v), format(v, f, ctx), input(f, v, ctx) } },
  functions:  { discount: { arity: 2, kind(argKinds), run(args) } },
  blocks:     { 'loyalty.award': { summary, effects, requires, connector?, check?(step, h), exposes?(step), nested?(step), run(ctx) } },
  transports: { log: { summary, validate(connector) → [[key, message, hint]], deliver(row, connector, opts) → { status, code, error } } },
  widgets:    { chess: { summary, client, props?: [keys], check?(node, h) } },
};
```

A name already taken by a built-in or another plugin is a load error; a plugin that cannot be
imported makes the graph invalid. `connector.send { connector, body }` queues to any connector,
so a plugin transport needs no block of its own. The checker knows about a plugin only what it
declares: the graph stays closed, the plugin is trusted code, and the boundary is the file.

### Shared plugins

`plugins/` at the repository root holds plugins any app may list (paths are relative to the app
directory, e.g. `"plugins": ["../../plugins/payment.mjs"]`).

- `payment.mjs` — a sandbox card gateway. Connector `{ "kind": "payment", "currency": "USD" }`.
  Block `payment.charge { connector, amount, card }`: authorises synchronously (the card must pass
  the Luhn check; the test card `4000000000000002` is declined; a declined charge refuses the whole
  action, rolling it back) and queues the capture to the connector, visible in `/outbox`. Exposes
  `@authorization` (a reference string) and `@payment` (the delivery id).
- `messaging.mjs` — SMS and WhatsApp alerts (the stand has no gateway, like mail: recorded in the
  outbox, never actually sent). Connectors `{ "kind": "sms", "from": "+1555…" }` / `{ "kind": "whatsapp", "from": "+1555…" }`
  (`from` must look like E.164). Block `sms.send { connector, to, text }`: `connector` may be either
  kind, `to` must look like E.164 and `text` may never be empty; `{row.field}` placeholders in `text`.
