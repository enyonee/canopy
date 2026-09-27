# fitness — webgen-bench/000076

## Weakened cases

- **Case 2/"visible under the user's exercise records".** `Exercise` is not `own`-scoped (see
  Misses for why), so "the user's exercise records" is the saved list `/list/my-exercises`
  (`where: {"user": "@me"}`), not the raw `/Exercise` route — which stays a public activity feed
  anyone can browse, by design (a leaderboard needs to read everyone's rows unfiltered).
- **Case 1 ("navigate away without issues").** Read literally as "the page the leaderboard links
  to also works" — the check follows the entity link a guest actually has (the public activity
  feed) rather than asserting anything about client-side navigation, which the format's
  server-rendered scaffold has no notion of.

## Misses

- `composition` — own-scoping is all-or-nothing per entity/role: declaring `Exercise` `own:"user"`
  for the `user` role would make `db.aggregate`'s dashboard path narrow **every** card and table
  over `Exercise` to the viewer's own rows (`runtime/server.mjs`'s `ownWhere` merge applies
  uniformly, dashboard by dashboard has no opt-out) — which is exactly what a public leaderboard
  must *not* do. There is no per-dashboard override of a role's ownership, so this app resolves
  the conflict by not declaring `own` at all and doing the personal filtering explicitly
  (`where: {"user": "@me"}` on the two saved lists and the four `mystats` cards) — which also
  means a signed-in user can open another user's `/Exercise/:id` directly; nothing in
  `ui_instruct` exercises that boundary, so it was left open rather than reached for a stronger
  mechanism the format doesn't have.

## New for this app

- A dashboard used as the **home route** (`"home": "/dashboard/mystats"`) rather than a page or an
  entity list — the personal-stats requirement is a dashboard by nature (several summed/counted
  cards), and the format allows any route there.
- A public (no `roles`) dashboard `table` with `groupBy` on a `ref` field and no `where` at all,
  deliberately relying on the *absence* of `own` on the grouped entity so every viewer's role sees
  the same global ranking — the mirror image of the owned, per-viewer dashboards in
  `apps/attendance` and `apps/datasci`.
