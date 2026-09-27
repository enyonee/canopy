# cleaning — webgen-bench/000018

## Weakened cases

- **Case 5 (check status by a booking reference).** `reference` is a plain `text` field set
  by a `Booking.created` event (`{"set": {"reference": "@row.id"}}`); an expression cannot
  reach the row's own id to prefix it (`concat('BK-', row.id)` is rejected by the checker:
  `id` is not a declared field an expression may read, only `@row.id` as a literal
  substitution is). So the "reference" is the booking's id as text, not a distinct code —
  functionally a reference lookup (a genuine stored, searchable field), just not
  cosmetically different from the id.
- **No login anywhere in this app** (open site, see `apps/leads` precedent and
  `runtime/auth.mjs` — permission checks no-op without a `roles` block): the status lookup is
  a public search box, not scoped to "my bookings"; anyone who guesses or is given a
  reference number can see that booking's details, and an empty search lists every booking.
  No case tests access control, so this is accepted rather than built around.
- Cases 1–4 checked as specified.

## Misses

- `composition` — an expression cannot read a row's own `id` (only declared `data` fields);
  a human-friendly prefixed reference code (`BK-<id>`) is therefore not derivable purely in
  the graph without a plugin.

## New for this app

- Two named `lists` over the *same* entity (`book`, `status`) with different `columns`,
  `search` and `create` — one nav destination for creating bookings, a separate one for a
  reference lookup, while the entity's own default `Booking.list` is hidden from nav.
- A `created` event whose only step writes back into the very row that triggered it
  (`db.update` with no `entity`/`id` — the current row is the new row, confirmed by
  `runtime/server.mjs`'s `runSteps` lazily fetching `ctx.row` from `ctx.id` when absent).
