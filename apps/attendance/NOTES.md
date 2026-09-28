# attendance — webgen-bench/000048

## Weakened cases

- **Case 1/2 (clock in/out).** "Clock in" is the entity's own create form with an empty `fields`
  list (just a submit button; `fill` stamps `clockIn = @now`), because a global action cannot
  update an arbitrary row afterwards (see Misses) and this needed no such thing. "Clock out" is a
  status transition (`open → closed`) on the row itself, which *can* update the current row.
  Employees reach it as a row action on their own attendance list — there is no separate "shift"
  concept above the session row.
- **Case 3 ("attendance time and absence time").** Modelled as two own-scoped views: the
  `Attendance` list (derived `hoursWorked` per session) and a separate `Absence` log the employee
  can also report into. The format has no single view joining two entities into one feed, so
  "attendance time and absence time" is two lists, not one.
- **Case 5 (statistics).** The dashboard's unfiltered "hours logged" card includes the session
  the check itself just opened and closed a moment earlier, so its value is real but not
  reproducible to the second; the check pins numbers only on the period-filtered dashboard
  (`?from=2026-09-20&to=2026-09-21`), which excludes that live session and is fully deterministic.

## Misses

- `block` — round 5 added `db.set` (an update on an arbitrary found/each/referenced row, the same
  `entity`+`id` override `db.adjust` already had) — but retrofitting "clock in creates-or-reopens
  today's row" here would be a speculative redesign, not a clear win: no case asks for "clock in
  twice in one day" to merge into one row rather than open a second session, and the current
  "always create a fresh session" design already supports the realistic case a resume-flow would
  complicate (a lunch-break out-and-back, two genuinely separate sessions on the same date). Left
  as-is; `db.set` has no obvious retrofit site in this app, same conclusion apps/coaching reached.
- `function` — round 5 added `hours()`/`minutes()` to the core expression algebra, but they
  infer kind `number` (see `runtime/functions.mjs`'s `needTimes`) — and a derived field can only be
  `int`/`money`/`bool`/`text`/`date`/`time`, never bare `number` (`runtime/check/data.mjs` would
  reject it, suggesting `int` instead). `hoursWorked` genuinely needs its existing two-decimal,
  summable-as-money precision (`checks.mjs` asserts `7.75`/`8.00`/`23.75` exactly, including a
  dashboard `sum` over it) — `int := round(hours(clockOut, clockIn), 0)` would truncate every one
  of those to whole hours, a real precision loss, not a simplification. Nothing in the core
  algebra turns a plain `number` result into a `money` one without an existing `money`-kind value
  to multiply/divide it by (the trick `apps/stockreports`' `changePct` uses) — `Attendance` has no
  such field to piggyback on. The app-local `hoursBetween` plugin function (`money`-kind, two
  decimals) stays; it is still solving a real gap `hours()` does not.
- `composition` — a form's field set and a create button still can't vary by role (`byRole`
  replaces a *form's* field list per role, not a list's create-button visibility), so the admin
  still also gets a "Clock in" button on `/Attendance` (harmless — nothing stops an admin from
  clocking a shift — but it wasn't the intent).

## New for this app

- An entity `form` override with an **empty `fields` list**: the create route still runs (own
  field auto-filled by the role's `own` scoping, `clockIn` silently set by `fill`), so "clock in"
  is a plain button, not a form.
- A dashboard `period` on one entity (`Attendance.date`) while a second table (`Absences by
  employee`) on a different entity is intentionally left unscoped by it — periods narrow only the
  entities they name.
- A plugin `function` (rather than a `field` or `block`) used purely to compute a derived value
  from two of the row's own fields — the smallest possible plugin surface.
