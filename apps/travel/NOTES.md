# travel — webgen-bench/000096

## Weakened cases

- **Case 1 (search by departure, arrival and date).** Search is the list's filters: `fromCity`
  and `toCity` come from fixed option lists declared in the graph (not free text), `date` is
  a from/to range.
- **Case 2 (book a selected ticket).** The "booking process" is a one-click Book row action
  for the signed-in customer; the passenger count is a POST value (`values.passengers`)
  that the scaffold's button offers no input for, so the UI books one passenger while the
  check books two. The confirmation number is the booking id in the flash.
- **Case 3 (pay with a valid credit card, email receipt).** "Valid" is a 16-digit rule on a
  `password`-kind field (hashed, never rendered); there is no payment provider; the receipt
  is an outbox letter.
- **Case 4 (all past and current bookings).** Train, flight and hotel bookings are one entity
  with nullable references; cancelling does not return the seat or the room (see Misses).

## Misses

- `block` / `composition` — no conditional step: cancelling cannot return a seat *or* a room
  depending on `kind` (`db.adjust` on a null reference refuses). Not built; recorded.
- `composition` — action buttons carry no inputs, so quantities (passengers, nights) can
  only arrive as POST values.
- `composition` — the first `text` field is the row label, so a text `card` field would have
  become the booking's title; the card lives in a `password` field instead (which is also
  the right treatment for a secret).
- `composition` — an action's `after` cannot point at the created row (`{created}` is not
  substituted in paths), so booking lands on the Order status list with the number in the
  flash.
- `node kind` — per-night hotel availability (rooms is a counter, not a date-range
  inventory); a payment connector.

## New for this app

- List filters with explicit `options` on text fields (cities), alongside a date range.
- `values.*` inside action expressions (`coalesce(values.nights, 1)`,
  `row.pricePerNight * coalesce(values.nights, 1)`) and `{created}` in an action confirm.
- A `password` field outside the login entity, guarded by a `len()` rule, asked for by a
  transition (`fields: ["card"]`).
- Three actions on three entities creating rows of one entity with `@me` as owner, under
  `register` + `anonymous` roles where guests may search but not book.
