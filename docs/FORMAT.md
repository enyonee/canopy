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
| `seed` | starting rows, inserted once while the table is empty: `{ "Entity": [ {field: value} ] }` |
| `identity` | one fake current user, no login: `{ "entity": "Profile", "defaults": {…} }` — cannot be combined with `roles` |
| `roles` | real login, sessions and a permission matrix (below) |
| `views` | must be `"auto"`: list, form and detail of every entity are derived |
| `override` | shapes the derived screens (below) |
| `lists` | named saved lists at `/list/<id>` |
| `dashboards` | cards and grouped tables at `/dashboard/<id>` |
| `pages` | static pages at `/page/<id>` |
| `actions` | named step sequences: on a row (`in`) or global |
| `events` | steps that run on `Entity.created`, `.updated`, `.deleted` |
| `states` | status transitions per entity (below) |
| `connectors` | http and mail endpoints the app may send to |
| `rules` | checks and uniqueness per entity |
| `allowDestructive` | `true` lets a migration drop columns the graph no longer declares |

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
| `file` | an uploaded file; forms become multipart; the value renders as a download link |
| `password!` | secret; stored as a salted hash, never rendered, blank on edit keeps the old one |
| `money := <expression>` | derived field: computed on every read, never stored, never on forms |

A derived field may be `int`, `money`, `bool`, `text`, `date` or `time`. Its expression
is checked statically against the entity; cycles are refused.

The row's label (in links, selects and titles) is its first `text` field, else `#id`.

## Expressions

Used in derived fields, `rules[].check`, and inside steps as `"= <expression>"`.

- Arithmetic `+ - * /`, comparisons `= != < <= > >=`, `and or not`, parentheses.
- Fields of the current row by name: `qty * price`. One hop through a reference: `customer.discount`.
- Aggregates over rows that reference this one: `sum(OrderItem: qty * price)`, `count(Activity)`,
  `count(Activity: not done)`, `avg/min/max(Child: field)`. The child must have exactly one
  `ref` to this entity, or name it: `count(Pair.first)`.
- Functions: `if(cond, a, b)`, `days(later, earlier)` (calendar days), `round(x, n)`, `abs(x)`,
  `min(a, b)`, `max(a, b)`, `coalesce(a, b, …)`, `len(text)`, `lower(text)`, `upper(text)`,
  `concat(a, b, …)`.
- Clock: `today` (date), `now` (time).
- Money is in major units inside expressions (`price > 100` means 100.00).
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
- `where`: a fixed filter, e.g. `{ "active": 1 }`; comparisons `{ "field": { "gte": …, "lte": …, "gt": …, "lt": …, "ne": …, "in": [...], "like": … } }`; `"@me"`, `"@today"` allowed
- `sort`: `{ "field": "createdAt", "dir": "desc" }`
- `rowActions`: any of `"view"`, `"edit"`, `"delete"`, `"go:<transition>"`, `"<action name>"` (an action with `"in"` this entity); default `["edit", "delete"]`
- `labels`: `{ "done": ["Open", "Done"] }` captions for a boolean

`Entity.form`:
- `title`, `intro`, `submit` (button caption), `fields` (stored fields to show), `fill` (values set silently on create, e.g. `{ "author": "@me" }`)
- `confirm` (flash after create), `after` (path after create, `{id}` or `{field}` substituted), `afterEdit`, `confirmEdit`
- the status field of an entity with `states` is never on the form; the owner field of a role with `own` is never on the form

`Entity.detail`:
- `fields` (which to show; derived allowed), `labels`
- `actions`: row actions shown as buttons
- `related`: `[ { "entity": "OrderItem", "via": "order", "title": "Items", "columns": [...], "form": ["qty"] | false, "fill": {…}, "submit": "Add", "confirm": "…", "rowActions": ["edit", "delete"] } ]` — a child table with an inline add form

## Lists, dashboards, pages

`lists`: `{ "id": "cart", "entity": "Order", "title": "Cart", "where": { "customer": "@me", "status": "cart" }, "columns": [...], "rowActions": [...], "sort": {…}, "search": [...], "create": true, "roles": ["customer"], "hidden": true }`.

`dashboards`: `{ "id": "sales", "title": "Sales", "intro": "…", "roles": ["admin"], "period": { "Order": "createdAt" }, "cards": [...], "tables": [...] }`
- `period` maps entities to their date/time field and adds a from/to form; every card and table on those entities is narrowed
- card: `{ "title": "Revenue", "entity": "Order", "fn": "sum", "field": "total", "where": {…} }` — `fn` is `count` (default), `sum`, `avg`, `min`, `max`; money renders as money
- table: `{ "title": "By status", "entity": "Order", "groupBy": "status", "groupTitle": "Status", "groupUnit": "month", "where": {…}, "metrics": [ { "fn": "count", "as": "n", "title": "Orders" }, { "fn": "sum", "field": "total", "as": "revenue", "title": "Total" } ], "sort": { "field": "revenue", "dir": "desc" }, "limit": 10 }` — `groupUnit` (`day`, `month`, `year`) buckets a date/time `groupBy`; `where` may use `"@me"`

`pages`: `{ "id": "about", "title": "About", "heading": "…", "body": ["paragraph", …], "links": [ { "label": "Shop", "href": "/Product" } ], "actions": ["<global action>"], "roles": [...] }`.

## Actions, steps, blocks

`actions`: `{ "name": "addToCart", "in": "Product", "title": "Add to cart", "by": ["customer"], "after": "/list/cart", "confirm": "{row.name} added", "do": [ <step>… ] }`.
An action with `in` runs on a row (`POST /Entity/:id/action/<name>`, offered through `rowActions` or `detail.actions`); without `in` it is global (`POST /action/<name>`, offered through `pages[].actions`).
`by` names the roles that may run it; without `by`, the role needs `do:<name>` (or `do:*`) on the entity (global actions: on `"*"`).
`confirm` interpolates `{row.field}`, `{found.field}`, `{created}`, `{made}`, `{delivery}`, `{me}`; money formats as `12.34`.

Every step is `{ "block": "<name>", …parameters }`. Values may be literals, `"@row.field"`, `"@each.field"`, `"@found.id"`, `"@picked.field"`, `"@values.name"`, `"@me"`, `"@created"`, `"@now"`, `"@today"`, or `"= <expression>"`.

| block | parameters | does |
|---|---|---|
| `db.create` | — | creates a row of the action entity from the submitted values |
| `db.createRow` | `entity`, `values` | creates a row of `entity` from literal/resolved values; `@created` is its id |
| `db.update` | `set` | updates the current row |
| `db.delete` | — | deletes the current row |
| `db.toggle` | `field` | flips a boolean of the current row |
| `db.adjust` | `field`, `by`, optional `entity` + `id`, `min`, `message` | adds `by` to an int/money field (stock, balances); refuses below `min` |
| `db.ensure` | `entity`, `where`, optional `values` | finds the first row matching `where` or creates it; `@found` is the row, `@made` says which |
| `db.each` | `from`, optional `where`, `do` | runs the nested steps once per row; the row is `@each` |
| `random.pick` | `from`, optional `weight` | picks a random row; `@picked` |
| `check.matchRef` | `ref`, `field`, `against`, `into` | compares a field with one on a referenced row, writes 1/0 |
| `http.send` | `connector`, `body`, optional `path` | queues a JSON request to an http connector; delivered after commit |
| `mail.send` | `connector`, `to`, `subject`, optional `text` | queues a letter; `{row.field}` placeholders in subject/text |

Steps run inside one transaction; a block that refuses (not enough stock, no such row) rolls
everything back and answers 400 with its message. Outgoing effects wait in the outbox and are
delivered after the commit; `/outbox` shows every delivery with its status and a retry button.

`events`: `{ "on": "Lead.created", "do": [ <step>… ] }` — `created`, `updated` (after a form edit), `deleted` (the row is `@row` as it was).

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

## Roles

```json
"roles": { "entity": "User", "login": "email", "password": "password", "role": "role",
  "register": "customer", "anonymous": "guest",
  "can": { "admin": "*",
           "customer": { "Product": ["view", "do:addToCart"], "Order": { "own": "customer", "can": ["view", "create", "go:pay"] }, "*": ["do:ping"] },
           "guest": { "Product": ["view"] } } }
```
- `entity` has a `text` login, a `password` field and an `enum` role field; seed users with plain passwords.
- `register` (optional): the role a visitor gets from `/register`; without it there is no self-registration.
- `anonymous` (optional): the role of a visitor without a session; without it every page asks for login.
- Operations: `view`, `create`, `edit`, `delete`, `go:<transition>`/`go:*`, `do:<action>`/`do:*`, `*`; entity `"*"` is the fallback.
- `own`: a `ref:<user entity>` field; the role sees, edits and transitions only rows where it equals the session user, and the field is filled from the session on create.
- Lists, dashboards and pages take `"roles": [...]`; the menu shows only what the viewer may open.
- Routes: `/login`, `/register`, `POST /logout`. A signed-in user is shown in the header. A denied GET redirects to `/login?next=…` when anonymous, else 403.

## Connectors, rules

```json
"connectors": { "crmHook": { "kind": "http", "url": "http://127.0.0.1:8999/hooks/crm", "method": "POST", "headers": {…} },
                "mail": { "kind": "mail", "from": "shop@example.test" } }
"rules": { "OrderItem": [ { "check": "qty > 0", "message": "Quantity must be at least 1" } ],
           "User": [ { "unique": "email", "message": "…" } ] }
```
Rules run on create and edit; a failing rule re-renders the form with the message (400).
Mail is recorded in the outbox (the stand has no SMTP); http is really sent.

## Routes the runtime serves

`/` → home · `/Entity` list (`?q=`, `?<filter field>=`, `?<field>_from=&<field>_to=`) · `/Entity/new` · `POST /Entity` · `/Entity/:id` detail · `/Entity/:id/edit` · `POST /Entity/:id` edit · `POST /Entity/:id/delete` · `POST /Entity/:id/action/<name>` · `POST /Entity/:id/go/<transition>` · `POST /Entity/:id/add/<Child>` (related form) · `/list/<id>` · `/dashboard/<id>` (`?from=&to=`) · `/page/<id>` · `POST /action/<name>` · `/outbox`, `POST /outbox/:id/retry` · `/file/Entity/:id/<field>` · `/login`, `/register`, `POST /logout`.

Every successful POST answers 303 to a page with `?ok=<flash>`; validation failures answer 400 with the form and the messages; refusals 403; a transition from the wrong status 409.

## Reading the HTML in checks

- Table rows are `<tr class="…">…</tr>`; a cell is `<td>…</td>`; a reference renders `<a href="/Entity/3">label</a>`; money `12.50`; a status `<span class="status">Placed</span>` (capitalised); booleans `Yes`/`No` or the declared labels.
- Detail pages are `<tr><th>Field Name</th><td>value</td></tr>`; field names are split on capitals (`createdAt` → `Created At`).
- The flash is `<p class="flash">…</p>`; dashboard cards are `<div class="metric"><b>value</b>Title</div>`.
- Forms: `<input … name="field">`, `<select name="field">`, buttons `<button type="submit">Caption</button>`; transition forms post to `/Entity/:id/go/<name>`.
