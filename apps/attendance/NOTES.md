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

- `block` — no block updates an arbitrary already-found row. `db.ensure` exposes `@found`, and
  `db.adjust` accepts an explicit `entity`+`id`, but `db.update` only ever writes the current
  action/transition row. A "clock in creates-or-reopens today's row, then stamps a field on it"
  flow (the obvious modelling of attendance) needs `db.update` to take the same `entity`+`id`
  override `db.adjust` already has; without it, clock-in had to become "always create a fresh
  session" instead of "resume today's".
- `function` — the core expression algebra has arithmetic only over `number`/`money`, and no
  time-difference function (`days()` is calendar-day only, dateless of time-of-day). "Hours
  worked" from two `time` timestamps needed an app-local plugin function (`hoursBetween`,
  `plugins/attendance-calc.mjs`), reusing the `money` kind as a two-decimal number carrier since
  a derived field can only be `int`/`money`/`bool`/`text`/`date`/`time`.
- `composition` — a form's field set and a create button can't vary by role, so the admin also
  gets a "Clock in" button on `/Attendance` (harmless — nothing stops an admin from clocking a
  shift — but it wasn't the intent).

## New for this app

- An entity `form` override with an **empty `fields` list**: the create route still runs (own
  field auto-filled by the role's `own` scoping, `clockIn` silently set by `fill`), so "clock in"
  is a plain button, not a form.
- A dashboard `period` on one entity (`Attendance.date`) while a second table (`Absences by
  employee`) on a different entity is intentionally left unscoped by it — periods narrow only the
  entities they name.
- A plugin `function` (rather than a `field` or `block`) used purely to compute a derived value
  from two of the row's own fields — the smallest possible plugin surface.
