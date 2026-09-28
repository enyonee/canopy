# recycling — webgen-bench/000061

## Weakened cases

- **Leaderboard identity.** There is no login (a kids' arcade game asking for an account
  would be an odd first ask), so a "player" is just a typed name on a `Player` row — nothing
  stops two different children from both typing "Alex", and nothing reunites the same child
  across visits. The leaderboard is honestly a *session* leaderboard (one row per completed
  game), not a per-person high score.
- **Cartoon styling.** The `theme` node only carries `background`/`accent`; "cartoon" comes
  from the widget's own emoji and rounded borders, not from anything the scaffold's shared
  CSS can be told to do — the rest of the site (lists, forms) stays the same plain
  administrative scaffold every other app in this repo has.
- **"Introductory screen" is per widget mount, not per game.** Reloading a game already in
  progress shows the instructions screen again before the tray — simpler than tracking
  "has this particular browser already seen the instructions", and harmless (a "Start
  Sorting!" click away from exactly where the player left off, since drops already made stay
  recorded on the row).

## Misses

- `composition` — no per-row "already claimed" flag to lean on (`WasteItem` is shared across
  every session), so "don't let the same item be dropped twice in one game" is tracked as a
  JSON array of ids on the `GameSession` row itself (`dropped`), reset by the `newGame`
  transition — a hand-rolled substitute for a join-table `unique` the format has no way to
  scope to "this session only".
- `node kind` — the status enum's checker requires every value to be some transition's `to`
  (docs/FORMAT.md: "every status must be reachable"), even though `finished` is actually
  reached by the block's own `store.update` during ordinary play, exactly as
  `apps/tictactoe`'s `x_won`/`o_won`/`draw` are. A `forfeit` transition (`playing` ->
  `finished`, no side effects) exists to satisfy that structural rule — and doubles as an
  honest "end the game early" feature, so nothing was added purely to appease the checker.
- `block` — no conditional/composable steps meant `recycle.drop` is one JS function doing
  four things (refuse if over, refuse a repeat, grade, maybe finish + badge) rather than a
  composition of smaller graph-level steps.

## New for this app

- A block that both **refuses** (an illegal or repeat move, tictactoe-style) and **always
  succeeds while grading a "wrong" answer** — a miss is not an error, it is a correctly
  recorded 0-point drop with a gentle-correction message, while a genuinely illegal action
  (game already over, unknown item/bin, repeat drop) is a real 400 refusal.
- A leaderboard built from `lists` with `where: { status: "finished" }` over the same entity
  a widget writes to continuously (`GameSession`) — the first app where a saved list's filter
  is the thing that turns an ordinary entity table into a "results only" board.
- The reward screen is asserted only through a real browser (`openBrowser`): it is rendered
  entirely by the widget from the row's own `badge`/`status` fields, so a plain HTTP fetch of
  the page (as most other checks in this app use) would only ever see the empty mount point.
