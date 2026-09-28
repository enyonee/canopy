# fitness — webgen-bench/000076

## Weakened cases

- **Case 1 ("navigate away without issues").** Read literally as "the page the leaderboard links
  to also works" — the check follows the entity link a guest actually has (the public activity
  feed) rather than asserting anything about client-side navigation, which the format's
  server-rendered scaffold has no notion of.

## New for this app

- A dashboard used as the **home route** (`"home": "/dashboard/mystats"`) rather than a page or an
  entity list — the personal-stats requirement is a dashboard by nature (several summed/counted
  cards), and the format allows any route there.
- A public (no `roles`) dashboard `table` with `groupBy` on a `ref` field and no `where` at all,
  now relying on `own`'s `"all": ["view"]` (round 5) rather than the absence of `own` — every
  viewer's role sees the same global ranking regardless of ownership, the mirror image of the
  owned, per-viewer dashboards in `apps/attendance` and `apps/datasci`.
- Round 5: `own` grew `all`, closing the Miss above. `user.Exercise` is now `{"own": "user",
  "can": ["edit", "delete"], "all": ["view", "create"]}` — the public activity feed and the
  leaderboard (and `mystats`'s own `"where": {"user": "@me"}` cards) stay exactly as unscoped as
  before (`view` is in `all`), but a user may now edit or delete their own exercise entries,
  which a plain unscoped grant never allowed; a signed-in user opening another user's
  `/Exercise/:id` directly still only *views* it (unchanged) and cannot edit or delete it
  (changed — this was the one open boundary the old Miss named).
