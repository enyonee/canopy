# domains — webgen-bench/000039

## Weakened cases
- Case 1 (availability lookup): the "search" is a substring search over the seeded registry; there is no WHOIS/registry lookup, so an unlisted name simply returns nothing.
- Case 2 (leasing process): the expiry date is typed on the lease form instead of being computed from a term; the order is created unpaid and paid in a second step on the order.
- Case 3 (renew): renewal asks for the new expiry date (rule: must be in the future) rather than adding a year.
- Case 4 (transfer): one step by the holder; the receiver does not accept. Both letters are visible only to the admin in the outbox (customers have no outbox).

## Misses
- Date arithmetic (`expiresAt + 1 year`) — `block` (an expression function such as `addDays`).
- Row-level guard on a transition ("only the holder may renew/transfer") — `composition`: emulated with `db.adjust ... by "= if(holder = me, 1, -1)", min 0`, which also counts renewals/transfers; an honest form would be a `check.assert` block or a `where` on the transition. `own` cannot be used because customers must also see and lease unowned domains.
- Order creation inside a transition: `db.createRow` must be the last step, and the confirm text cannot name the domain — the runtime copies the created id over the current row's id (`Object.assign(ctx, out)` in `runSteps`), so later steps and `{row.*}` read the wrong row. Runtime defect, worked around by ordering; not a format miss.
- Real payment — `connector` (payment gateway); paying is a status transition with a method field.

## New for this app
- A transition that keeps its status (`from: [leased], to: leased`) for renew and transfer.
- `mail.send` to two parties from one transition, and `{values.x}` / `{created}` in a confirm text.
- A stored ref field (`transferTo`) that exists only to be asked on a transition form.
- Saved lists filtered on a derived int against `@me` (`daysLeft lte 30` + `holder = @me`) and a role-restricted dashboard with a period.
