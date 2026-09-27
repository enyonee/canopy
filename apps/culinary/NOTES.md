# culinary — webgen-bench/000066

## Weakened cases

- **Case 1 (browse nearby restaurants).** There is no geolocation, so "nearby" is the whole
  restaurant directory (5 restaurants across two cities), filterable by `city`. The check reads
  the full list rather than a distance-sorted subset.

## Misses

- `connector` — no geolocation/maps connector to compute or sort by real distance.
- `field kind` — average rating is a whole-number `int` field (`avg(Review: stars)`, rounded to
  the nearest star like the reference `camping` app), not a half-star-precision decimal.

## New for this app

- A city filter on a plain `text` field with explicit `options` (no ref/enum backing it), the
  same construction `travel` used for `fromCity`/`toCity`.
- A member-only related add-form under a public-read entity (`Review` under `Restaurant`) with
  no `own` scoping at all: any member may post a review under any restaurant, and every visitor
  (including guests) can already see every review — the simplest correct reading of "view other
  users' reviews... add their own", since nothing in the brief asks for private reviews.
