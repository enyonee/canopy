# camping — webgen-bench/000097

## Weakened cases
- Case 2 (book a campsite, "Payment"): payment is the `confirm` transition with a `paymentMethod` enum and a
  mail in the outbox; no money moves and no payment provider is called. The check tests the transition,
  the flash with date and location, the 409 on a second confirm and the letter.
- Case 3 (review a "recently visited" campsite): nothing ties a review to a past booking; anyone can
  review any place. The check tests the rule 1..5, the row under the place and the derived count/average.
- Case 4 (navigate country "sections"): a section is the country page (`related` places) plus the
  `?country=` filter; there is no per-country landing page with its own text.

## Misses
- `connector`: a payment provider (would be `http`, not declared: its port differs between runs).
- `composition`: a "has visited" gate for reviews needs a rule that looks at sibling rows of another
  entity by e-mail (`count(Booking.place: email = <this review's e-mail>)`): aggregates cannot correlate
  with the current row, so it is not expressible.
- Observed, not a format gap: the checker's dependency walk resolves names inside an aggregate body
  against the outer entity, so `Place.rating := avg(Review: rating)` was reported as `Place.rating →
  Place.rating`; renaming the child field to `stars` avoids it.

## New for this app
- A derived `text` with two reference hops (`concat(place.city, ', ', place.country.name)`) shown on
  the list and the detail; `int := avg(Review: stars)` rounding an average; `count(Place)` on the parent.
- A country page built only from `detail.related` (no form) as a "section".
