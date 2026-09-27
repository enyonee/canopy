# poetry — webgen-bench/000070

## Weakened cases

- None outright, but see the identity/seed gotcha below, which shaped how the seed data is
  written.

## Misses

- None beyond the shared `identity` limitations already documented elsewhere (single
  simulated visitor, no way to tell two posters apart).

## New for this app

- **`identity` runs before `seed`, so seeding a row into the identity's own entity is
  silently dropped.** `runtime/server.mjs` creates the identity's row (or reuses the last
  existing one) *before* the seed step runs; by the time `seed` tries to insert into that
  same entity, the table is no longer empty, so the seeded row never appears and any
  `"author": 1` in other seeded rows ends up pointing at the identity's own auto-created
  default instead of the poet we meant to seed. The fix used here: don't seed a separate row
  into the identity entity at all — set the *identity's own* `defaults` to the poet's real
  name and bio (`identity.defaults.name = "Iris Marlow"`), and have every seeded `Poem`
  reference `author: 1`, which is guaranteed to be that one identity row. `apps/forum`
  (round 1) avoids the trap the same way, by never seeding its `Profile` entity either.
