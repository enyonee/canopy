# cleaning — webgen-bench/000018

## Weakened cases

- **No login anywhere in this app** (open site, see `apps/leads` precedent and
  `runtime/auth.mjs` — permission checks no-op without a `roles` block): the status lookup is
  a public search box, not scoped to "my bookings"; anyone who guesses or is given a
  reference number can see that booking's details, and an empty search lists every booking.
  No case tests access control, so this is accepted rather than built around.
- Cases 1–4 checked as specified.

## Misses

_None left specific to this app — the one Miss it used to record (see New for this app) is
closed._

## New for this app

- Round 5: expressions can now read the current row's own `id` (read-only) — closing the "a
  human-friendly prefixed reference code is not derivable purely in the graph" Miss. The
  `Booking.created` event now sets `reference` to `"= concat('BK-', id)"` instead of copying the
  bare id (`"@row.id"`), so a booking's reference is a real "BK-123"-style code end to end: shown
  on the confirmation page, and looked up by that exact string on the status list's `search`
  (`reference` stays a stored field — not a derived `:=` one — since `Entity.list.search` only
  matches stored fields; the new expression capability upgrades what gets *written* into it, not
  its kind).
- Two named `lists` over the *same* entity (`book`, `status`) with different `columns`,
  `search` and `create` — one nav destination for creating bookings, a separate one for a
  reference lookup, while the entity's own default `Booking.list` is hidden from nav.
- A `created` event whose only step writes back into the very row that triggered it
  (`db.update` with no `entity`/`id` — the current row is the new row, confirmed by
  `runtime/server.mjs`'s `runSteps` lazily fetching `ctx.row` from `ctx.id` when absent).
