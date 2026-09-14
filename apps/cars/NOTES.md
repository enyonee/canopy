# cars — webgen-bench/000098

## Weakened cases
- Case 2 ("whether the selected car is available for the chosen dates"): availability is a `units`
  counter on the car (`available := car.units > 0` on the draft, `db.adjust … min 0` when paying),
  not an overlap test against other bookings' dates. The check tests the Yes/No flag, the date-order
  rule and the refusal when no unit is left.
- Case 4 (payment): "processed" means the `pay` transition with a `paymentMethod` enum and a mail;
  no provider is called. The unique reference is the row id in the flash and the bookings list; the
  page title is the derived `carType` because a derived text field is the row label (see Misses).

## Misses
- `block`: a date-overlap check (`check.overlap` or a correlated aggregate such as
  `count(Booking.car: start <= row.end and end >= row.start)`); the expression language cannot
  reference the current row from inside an aggregate body.
- `connector`: a payment provider (`http`, not declared).
- `node kind`: a time-of-day field; `time` is an ISO timestamp that never appears on forms, so pick-up
  and return times are an `enum` of slots.
- `composition`: the row label is the first `text` field and a derived text counts, so a booking with
  `carType := car.type` is titled "economy" instead of `#id`; keeping the type on the summary cost
  the id as the title.

## New for this app
- `identity` with `fill: { "customer": "@me" }` and `@row.customer.email` as a mail target; a derived
  `bool` and a derived `text` through a reference hop; `db.adjust` with a literal `by` on another
  entity in three transitions (take, return, cancel); a partial edit (`end` and `returnTime` only)
  re-deriving `days` and `total`.
