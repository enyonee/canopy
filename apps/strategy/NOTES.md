# strategy — webgen-bench/000011

## Weakened cases

- **Case 4 (store).** "The selected item should be removed from the store" is read literally: every
  `StoreItem` carries a real `stock`, decremented atomically on purchase (refusing at 0), and the
  store's own list is filtered to `stock > 0` — a sold-out item genuinely disappears, not a cosmetic
  label change.
- **The five gameplay pages (base/train/workers/upgrades/bank) are one saved list repeated five
  times**, each `{ "entity": "User", "where": { "id": "@me" } }` with a different `rowActions` subset
  and column set — not five bespoke screens. A plain `action`'s button carries no input fields of
  its own (only a `states` transition's `fields` can — see Misses), so every one of these pages was
  designed so its buttons need no input at all: picking a race, a store item or an opponent is
  picking a ROW (whose own id supplies the "which one"), and every resource-affecting action here
  has a single fixed cost/effect per click (train one worker, deposit 100 gold, reassign for a flat
  20 gold) rather than a free-form quantity a form would have to collect.
- **Battles and messages/reports are real (see New for this app) but not exercised by their own
  ui_instruct case** — the task names them in its instruction text but none of the nine graded
  `ui_instruct` cases actually tests attacking, messaging or reports, so `checks.mjs` (one entry per
  case, per the brief) has no dedicated case for them; they were built anyway rather than skipped,
  since the instruction does ask for them.

## Misses

- `composition` — a bare `detail.actions`/`pages[].actions` button never carries input fields
  (only a `states` transition's `fields` do, and `states` governs one status-typed field, not
  general-purpose input collection) — the whole "one action per choice, not one form per action"
  design above exists because of this. Recorded here since it shaped nearly every screen in this
  app.
- `block` — `db.update`'s `set` always targets the CURRENT row; there is no entity/id override the
  way `db.adjust` has one. Choosing a race (`Race`'s own "choose" action needs to write to the
  *User* row, not the Race row it runs on) therefore needed one small custom block
  (`strategy.chooseRace`) — everything else numeric could stay a plain `db.adjust` with its
  `entity`/`id` override.
- `composition` — `own` (docs/FORMAT.md) scopes a *child* entity's ref-to-User field; it has no way
  to express "this row's own id equals the session user" for the `roles.entity` itself acting on
  its own rows. Every User-scoped action here opens with a small guard block
  (`strategy.requireSelf`) instead, because the role-level `do:<name>` grant alone does not vary
  per row (confirmed directly: `/User/<someone else's id>/action/upgradeCity` is refused only
  because of this guard, not because of anything `/roles` expresses on its own).
- `store.aggregate`/`where` — `{ field: { ne: null } }` is silently dropped (query.mjs's `clauses()`
  skips any comparison whose value is `null`, including inside `ne`), so there is no declarative
  "is not null" filter; the schedule tick just runs its formula for every player (a player with no
  race yet gets 0 racial bonus via `coalesce`) rather than trying to skip raceless players.

## New for this app

- A real `schedule` tick (`docs/FORMAT.md`'s Round-4 node) driving resource accrual: base income +
  city level + workforce + a doubled bonus for whichever resource the workforce is currently
  assigned to + the player's race bonus — `checks.mjs` predicts the exact numbers from the same
  formula and triggers the tick by hand as an admin (`POST /schedule/tick/run`), per the brief.
- `if(...)` and `coalesce(...)` composed inside one `db.adjust` "by" expression, reading through a
  ref hop (`each.race.goldBonus`) from inside a `db.each` — conditioning the *amount* of one step
  rather than which steps run (there is no conditional step).
- A formula-resolved battle (`strategy.attack`): soldiers x attack/defense rating, jittered ±20% by
  a seed derived from both sides' current state (not `Math.random()`), the winner looting a share
  of the loser's gold — writing a `Report` row for both sides and a `Message` to the defender,
  "messages and reports rows" from the brief, real even though no `ui_instruct` case checks it.
- Five saved `lists` over the same entity and the same `where: {"id": "@me"}`, each a different
  named "page" purely by choice of `rowActions`/`columns` — see Weakened cases.
