# reimburse — webgen-bench/000101

## Weakened cases
- Case 5 (settlement report "or provides an option to download it"): the report is the dashboard
  `/dashboard/settlement` with cards, a per-trip table and a period filter; nothing is downloadable.
- Case 6 (reimbursement status): the task names no roles, so the same identity submits, approves and
  pays; the check drives approve and pay itself to show the status page following them.
- Case 4: the reference number is the claim id, shown as the page title after a static flash; a flash
  with the number (`Claim #{created}`) was possible only from an action, dropped for the quirk below.

## Misses
- `node kind`: report export/download (a file rendering of a dashboard or list).
- `connector`: real booking systems for flights, hotels and trains ("API Integration" in the task
  category) would be `http` connectors, not declared.
- Observed, not a format gap: `db.createRow` returns `{ id }`, which `runSteps` copies over the
  action's `ctx.id`, so `{row.title}` after that step reads the *trip* whose id equals the new claim's
  id; the claim was moved from a Trip action to a `Claim` form plus a `Claim.created` event. Also
  `@me.email` resolves to the user id, not the field; use `@row.employee.email`.
- Claim amount is `money := trip.total`, so it follows later expense edits; a snapshot would need a
  stored copy written by `db.createRow` — expressible, not chosen.

## New for this app
- Four `related` sections with inline forms on one detail page; `Claim.created` event sending mail.
- A dashboard `period` mapping five entities to their own date fields; a table grouped by a text field
  whose metrics are derived money (in-memory aggregation); derived money through a reference hop.
