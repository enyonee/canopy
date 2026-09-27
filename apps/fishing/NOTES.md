# fishing — webgen-bench/000028

## Weakened cases
- **Case 1 / 3 ("the most recent contest").** With two independent entities
  (`Contest`, sorted by announcement time, and `Result`, which only exists for
  finished contests), "the latest contest's results" is asserted as "the results for
  the one contest that has them, filterable by contest" rather than an automatic
  "results of whichever contest is chronologically newest" — the newest-announced
  contest (Winter Ice Derby) hasn't happened yet and has no results at all.

## Misses
- `block` — no argmin/ranking aggregate exists (confirmed absent in REPORT.md's own
  miss catalog: "argmin-агрегат «какая строка минимальна»"), so `Result.rank` is a
  manually entered field, not computed from `weight`.
- `field kind` — no generic decimal/measurement field; `Result.weight` reuses `money`
  for its two-decimal precision (it is a weight in kg, not currency) since the format
  has no other fixed-point numeric kind.

## New for this app
- Registration is a `related` inline add-form on `Contest.detail` (the same shape as
  `crm`'s Lead/Activity and `fooddist`'s Opportunity/Signup), which is also the
  literal "provided registration form" the task instruction names — no separate
  `Registration.list` entry point is needed or offered (`hidden: true`).
- `Photo.image` is a real `image` field; the check itself performs a genuine
  multipart upload (a 1×1 PNG) rather than seeding a fake filename with no backing
  file, then confirms a signed-out guest sees the real rendered thumbnail — the
  honest way to prove "photos are visible without logging in" for a field kind that
  cannot be faked through seed data.
- `Contest.registrations := count(Registration)` is the first entity in this batch
  whose own detail page shows a live count of a `related` table just below it.
