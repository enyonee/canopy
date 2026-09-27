# species — webgen-bench/000088

## Weakened cases

- None. The instruction only asks for browsing, searching and filtering, and every case is
  driven through the real list route (`search:`/`filters:` query params), not a weaker
  stand-in.

## Misses

- `composition` — the instruction's "database ... for managing" (its `Category` metadata
  calls out CRUD Operations) is not reflected in any `ui_instruct` case, which only tests
  read access; the graph is deliberately read-only (`Species.list` has `create: false`, no
  `edit`/`delete` row actions) since nothing exercises a write path and a curated reference
  database is the more honest reading of "database for displaying ... biological information".
  If a future case needs editing, it is a one-line override change, not a format gap.

## New for this app

- No `roles`, no `identity` — the simplest possible app: pure `data` + `seed` + `views` +
  `override`, entirely public and entirely read-only (`create: false`, `rowActions: ["view"]`
  only), which the format allows without any permission scaffolding at all.
