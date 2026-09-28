# construction — webgen-bench/000085

## Weakened cases

- **Case 1 (project timeline / project calendar).** There is no calendar or Gantt view; "the
  project timeline" is the project's start/end date plus its `Task` list (each with a `dueDate`),
  read as a plain sortable table rather than a calendar grid.
- **Case 5 (resource availability charts).** No chart node exists in the runtime; "the chart" is
  the `Resource` list's `capacity`/`allocated`/`available` columns and an admin dashboard table
  grouped by resource kind — both plain tables, not a rendered graphic.

## Misses

- `node kind` — no chart node (see Weakened case 5); no calendar/Gantt node (see Weakened case 1).
- `field kind` — hours are logged as whole `int` hours (matching the reference apps' `hours`/
  `minutes` fields elsewhere, e.g. `hospital.DailyReport.hours`), not fractional decimal hours.

## New for this app

- Round 5 (item 3): a related child add-form's `fill` now reads the parent row's own fields
  (`"@row.project"`) — the Task → TimeEntry related form no longer needs the worked-around
  "let the child pick `project` itself, and add a rule to catch a mismatch" shape this app used
  before: `fill: {"project": "@row.project"}` sets it silently and correctly, `project` is off
  the visible form, and the `"task.project = project"` rule stays as a harmless, now-unreachable
  belt-and-braces check (removing a check was not the ask).
- Round 5 (item 1): `own` may now name several fields, closing the "sender OR recipient" Miss.
  `member.Message` is now `{"own": ["sender", "recipient"], "can": ["view", "create"]}` — a
  real two-party inbox instead of the "shared team log" every member could read before; the
  recipient's fixed-`where` "My Inbox" saved list is unaffected (its own filter and the role's
  own-scoping now agree instead of one substituting for the other). `Message.form`'s
  `fill: {"sender": "@me"}` was dropped too: `own` auto-fills the same field.

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
