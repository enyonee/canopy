# hospital — webgen-bench/000046

## Weakened cases

- **Case 4 (superior receives a notification).** The superior is chosen on the report form
  (no org chart of who reports to whom) and the notification is a letter in the outbox
  (mail connector; the stand has no SMTP).
- **Case 5 (update the inventory count).** The count is not typed in: the user records an
  in/out stock movement on the medicine page and the stock follows (`db.adjust`). Over-
  dispensing is refused, but with a 500 error page rather than the form (see Misses).
- **Case 6 (create and submit a claim).** One step: a claim is created directly in status
  `submitted`; approve/reject are admin transitions. There is no separate draft stage.
- **Case 9 (inventory report for a date range).** The period narrows the movements (units
  received / dispensed); stock levels on the same page are *current*, not "as of" the end of
  the range — a historical snapshot is not derivable.
- **Case 10 (scheduled to the calendar).** No calendar view: the theater schedule is the
  surgery list sorted by date with a date-range, room and surgeon filter; the start time is
  a text field (`09:30`).
- **Case 8 (navigation).** `navCheck(6)` runs as staff (12 entries); the admin-only Financial
  report is not in the staff menu by design.

## Misses

- `node kind` — a calendar/schedule view; a time-of-day field kind (`time` is a timestamp
  that never appears on forms), so start time is text.
- `composition` — refusal inside a `created` event answers 500 instead of 400 (refusal
  semantics only exist for actions and transitions).
- `composition` — stock "as of a date" cannot be derived from movements; only the flows of
  the period are reported.
- `composition` — "processing" a payment is a transition with a method field; there is no
  payment connector.

## New for this app

- `roles` with `own` on the report author, so staff see only their own daily reports while
  the superior sees all.
- `mail.send` from a `created` event to a referenced user's address (`@row.superior.email`)
  with `{row.author.name}` placeholders.
- A transition that writes into another entity (fee → ledger transaction) with a `concat`
  note, and a derived `money := sum(Fee: if(status = 'unpaid', amount, 0))`.
- `fill: { "technician": "@me" }` on a related inline form; `rowActions: ["go:approve"]`
  that renders only for the role named in `by`.
- Three period dashboards on three different entities, one restricted with `roles`.
