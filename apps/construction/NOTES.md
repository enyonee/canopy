# construction — webgen-bench/000085

## Weakened cases

- **Case 1 (project timeline / project calendar).** There is no calendar or Gantt view; "the
  project timeline" is the project's start/end date plus its `Task` list (each with a `dueDate`),
  read as a plain sortable table rather than a calendar grid.
- **Case 2 (communication tool).** `Message` has no true per-conversation privacy: `own` scopes a
  role to a single reference field, and a two-party inbox needs "sender OR recipient" visibility,
  which isn't expressible. Every signed-in member can read every message (a shared team log); the
  check only asserts what's true either way — the message really does land in the recipient's
  personal "My Inbox" saved list (`where: {recipient: "@me"}`), correctly timestamped.
- **Case 5 (resource availability charts).** No chart node exists in the runtime; "the chart" is
  the `Resource` list's `capacity`/`allocated`/`available` columns and an admin dashboard table
  grouped by resource kind — both plain tables, not a rendered graphic.

## Misses

- `composition` — a related child add-form's `fill` cannot read the parent row's own fields.
  `runtime/server.mjs`'s handler for `POST /Entity/:id/add/Child` resolves `fill` through the same
  top-level `resolveTop` used for a plain `Entity.form.fill` (`{user, values: {}}`, no `row` in
  scope), so `"fill": {"project": "@row.project"}` on the Task → TimeEntry related form silently
  resolves to nothing — confirmed empirically (the field stayed null after a real POST). Worked
  around by making the child pick `project` itself on the form and adding a rule,
  `task.project = project`, so the two must agree; the transition/action `do:` steps *do* have a
  real `row` in scope (`@row.field` there works, e.g. in `confirm` strings and `db.createRow`
  values across the reference apps) — only the related-add-form's `fill` lacks it.
- `node kind` — no chart node (see Weakened case 5); no calendar/Gantt node (see Weakened case 1).
- `composition` — `own` supports exactly one reference field, so a message inbox cannot be scoped
  to "sender OR recipient" (see Weakened case 2).
- `field kind` — hours are logged as whole `int` hours (matching the reference apps' `hours`/
  `minutes` fields elsewhere, e.g. `hospital.DailyReport.hours`), not fractional decimal hours.

## New for this app

- A rule that hops through a reference to compare against a *sibling* field on the same row:
  `TimeEntry` rule `"task.project = project"` — not a bound/derived check like `fooddist`'s
  `Signup` rule (`opportunity.open > 0`), but a cross-reference consistency check between a field
  and another field one hop away.
- A rule that hops through a reference to a derived field to enforce a live capacity constraint
  before the row exists: `ResourceAllocation` rule `"quantity <= resource.available"` — the
  aggregate that produces `resource.available` naturally excludes the not-yet-inserted row, so the
  check is exactly right at the moment it runs (extends the pattern fooddist introduced).
- Two arithmetically-combined aggregates in one derived field with a divide-by-zero guard:
  `progressPercent := coalesce(round(100 * count(Task: status = 'done') / count(Task), 0), 0)`
  (the `dmv` reference app's `score` field, reused for a different domain).
- A personal saved list scoping a role-visible-to-all entity down to "mine" purely for
  convenience/display (`inbox`, `my-timesheet`), distinct from a true `own` access boundary.
