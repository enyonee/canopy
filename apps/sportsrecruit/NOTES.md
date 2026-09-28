# sportsrecruit — webgen-bench/000054

## Weakened cases

- **Case 2 (organization login → "organization dashboard").** There is no separate
  dashboard screen for organizations; "reaching the dashboard without errors" is checked as
  reaching the Job listings page with the "Post a job" create button, the organization's real
  landing spot.
- **Case 4 (application "logged in the athlete's account history").** The account history is
  the athlete's own-scoped `my-applications` saved list (`where: {athlete: "@me"}`), not a
  free-form activity feed.
- **Case 5 ("receives the message promptly" / "a notification is displayed").** There is no
  push or polling in the format (a page is only ever computed on a request). The notification
  is a derived unread counter on the athlete's own profile row (`count(Message.to: not read)`)
  and a "New"/"Read" label on the inbox row; the check reads it after a fresh GET rather than
  observing a live update. Real-time delivery (a `Category.subcategories` item on this task) is
  out of scope for a request/response scaffold.
- The "Message" action button on a User row carries no text input in the rendered scaffold (a
  plain action button posts an empty body); the check sends the message body as a raw POST
  value, the same idiom apps/travel documents for `values.passengers`.

## Misses

- `node kind`: no real-time channel (WebSocket/poll) — the "Real-time Features" subcategory of
  this task's Category tag is not attempted; messaging is request/response with an unread count.
- `composition`: `own` scopes on a single ref field per role. Two different roles scoping the
  same entity by two different fields (organization owns `Message.from`, athlete owns
  `Message.to`) works cleanly; but the entity's create-side ref (`to`, any `User`) cannot be
  restricted to "athletes only" — an organization can technically message another organization
  or the admin through the same action, since ref-field options can't be filtered by the target
  row's own field value.
- `composition`: `Application`'s owner (organization of the job) is two hops away
  (`Application.job.organization`), so organizations get a plain unscoped `view` on
  `Application` rather than a per-organization scoped one — `own` only matches a direct ref
  field on the entity itself.

## New for this app

- Round 6: `rules.Application: [{"unique": ["athlete", "job"], ...}]` now stops an athlete
  applying to the same job twice — the only path to `Application` is the `apply` action's
  `db.createRow` step, no HTTP create route reaches it, and until this round `rules` only ran
  on an HTTP create/edit (`interp.validateValues`); the guard moved into the store itself
  (`Store#insert`/`#update`, `runtime/store/rules.mjs`), so the block path is covered too. See
  `docs/FORMAT.md`'s «Connectors, rules» and `checks.mjs`'s second `apply` assertion.
- Two different roles declaring `own` on two different ref fields of the same entity
  (`Message.from` for organization, `Message.to` for athlete) — confirmed against
  `runtime/auth.mjs` that each role's permission entry is independent, so this scopes both
  sides of a conversation correctly with no extra saved lists.
- A qualified correlated aggregate naming which reference to use when an entity has more than
  one ref to the aggregated entity: `count(Message.to: not read)` on `User`.
- An action with no `by` and no `in`-entity `own` restriction, gated purely through a
  `do:<name>` operation in the role's `can` list (`do:apply`, `do:contact`, `do:markRead`) —
  matches the `render.mjs` row-button visibility check, which only consults the permission
  matrix and ignores an action's `by` list (a button for a `by`-gated-only action would never
  render, even though the POST would still succeed).
- A saved list scoped to the signed-in user's own row on the login entity itself
  (`{"entity": "User", "where": {"id": "@me"}}`), used as a personal profile/notification page —
  `own` cannot express "my own User row" directly (it requires a `ref:User` field, and `User`
  has none pointing at itself), so the saved list's fixed `where` is the only way to get there.
