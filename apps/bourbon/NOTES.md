# bourbon — webgen-bench/000021

## Weakened cases

- **Case 2 (private poker room).** No membership/application flow is tested by the case, so
  it stays a static `pages` entry (benefits + how to join, in prose) rather than a modelled
  `Membership` entity with its own signup - the case only checks content, not an interaction.
- **Case 4 ("reservations or purchases").** Only reservations are modelled; there is no
  cart/checkout for buying menu items or event tickets, since the case's own wording
  ("reservation form... accept input data") only exercises the reservation path.
- Cases 1, 3 checked as specified.

## Misses

- (none beyond the two above, which are scope choices rather than format limitations)

## New for this app

- One entity (`Happening`) carries both "events" and "promotions" via a `kind` enum, so a
  single sorted, filterable list satisfies a case that asks for one combined page rather than
  two separate catalogues.
