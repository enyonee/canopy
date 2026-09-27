# detective — webgen-bench/000083

## Weakened cases

- **Case 4 (expense sheet) / Case 5 (assignment sheet).** Neither is a separate document — the
  format has no report/print view distinct from a detail page. Both are sections of `Case.detail`:
  three derived money fields (`totalHours`, `laborCost`, `estimatedExpense`) for the expense
  sheet, and the `Assignment` related table for the assignment sheet. "Displays all necessary
  details" / "presents all relevant information" is read as *this data must be present and
  correctly computed*, not as a distinctly formatted page.
- **Case 1 ("browsed").** Browsing is following links from the case list to each case's detail
  page (`/Case` → `/Case/1`, `/Case/2`), server-rendered, not a client-side "next/previous case"
  control the format doesn't have.
- **Case 6 ("back to the dashboard").** There is one dashboard (`overview`); "back" is the nav
  link every page carries to it, not a browser-history back button, which a server-rendered
  scaffold has no way to script.

## Misses

- `field kind` — no dedicated "duration"/decimal-hours kind; `TimeLog.hours` is `money`
  repurposed for two-decimal quantities (the same trick `apps/attendance` used for
  `hoursWorked`), which is why `totalHours * hourlyRate` type-checks at all: the algebra tags a
  product of two `money`-kind operands as `money`, which happens to be exactly the unit (hours ×
  rate/hour = currency) this sheet needs.
- `composition` — cases are not owned by an investigator (`own` was deliberately not used: a
  case is worked by more than one investigator, and the format's `own` is a single ref field, not
  a many-to-many "who's on this case"). That means any investigator can log hours or file a
  report against any case, not only ones they're assigned to on the `Assignment` sheet — the
  assignment table is informational, not an access boundary. Nothing in `ui_instruct` requires
  that boundary, so it wasn't built.

## New for this app

- Two derived `money` fields chained through a **third**: `estimatedExpense` reads `laborCost`,
  which reads `totalHours` (itself an aggregate, `sum(TimeLog: hours)`) — three layers of
  derivation, each one a plain read of the field below it, no cycle.
- A dashboard card whose `where` uses `{"in": [...]}` against an enum (`status`) rather than a
  single value, to count two different statuses ("open" and "active") as one "open cases" figure.
- Two `related` child tables on the same detail page feeding two different entities from two
  different forms (`Report`, `TimeLog`), plus a third, read-only, form-less related table
  (`Assignment`) on the same page — three uses of one mechanism for three different jobs.
