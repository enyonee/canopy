# tickets — webgen-bench/000099

## Weakened cases
- Cases 3 and 4 ("real-time seat availability"): seats are an `int` counter per trip, decremented by
  `db.adjust` when a booking is paid and refused below 0; no seat map and no live refresh. The checks
  test the counter column, the price and the search/filter.
- Case 5 ("secure payments", "confirmation via email or SMS"): payment is the `pay` transition with a
  `paymentMethod` enum; the confirmation is a mail in the outbox; there is no SMS. The check tests the
  flash, the seats drop 40 → 38, the 409 on a second payment, the overbooking refusal and the letter.
- Case 7 ("print their tickets in a print-friendly format"): the ticket is the booking's detail page
  plus the "My tickets" list of paid bookings; there is no print layout or PDF. The check tests that
  exactly the paid booking is listed and that the page carries passenger, trip, seats, total, status.
- Instruction-level, no ui case: "responsive design" is not testable here (viewport meta only).

## Misses
- `connector`: SMS gateway; payment provider (both `http`, not declared).
- `node kind`: a seat map (a per-seat entity would need a bulk create and a pick), a print/document
  view of a row, and layout/responsive knobs on `theme`.
- `composition`: booking from the trip page was avoided because `detail.related` lists child rows
  without the viewer's `own` scoping, which would show other travellers' bookings; bookings are
  therefore created from `/Booking/new` with a trip select.

## New for this app
- A derived text field as the entity label (`route := concat(origin, ' to ', destination)` is the
  first text field of Trip, so links and titles use it); `by: "= -row.qty"` on `db.adjust`.
- Saved lists restricted by role with a `where … in` on the status (history) and a paid-only list
  (tickets); otherwise nothing beyond what shop and crm used.
