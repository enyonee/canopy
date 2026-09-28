# game2048 — webgen-bench/000013

## Weakened cases

- **Case 1 (start a new game).** "Randomly placed" tiles are placed by a PRNG seeded on the
  row's own id (`draws` persists how many numbers have been drawn so far), so repeated plays
  differ from each other exactly as a real player would see, while `checks.mjs` can predict
  the exact outcome by importing the same pure functions the server block runs — the
  "deterministic randomness" path in docs/FORMAT.md, rather than a weaker invariant-only check.
- **Case 6/7 (game over / revive).** Reaching a genuine deadlock through only legitimate arrow
  moves is not guaranteed to terminate in a bounded number of requests for an arbitrary seed, so
  the checks engineer the deadlock board directly through the generic entity edit route
  (`POST /Game/:id`, left on the default form) the same way apps/tictactoe leaves `board`/`turn`
  writable there — not a hidden cheat, the same convention the reference app already uses. A
  `Game.updated` event (`game2048.sync`) recomputes `status`/`won` from whatever board results,
  so an edited-in deadlock is detected exactly like an organically-reached one would be.
  Reviving a *true* deadlock necessarily still refuses every direction afterwards (by definition
  no move is legal on that exact board) — the ui_instruct wording ("board in the same state...
  with additions of new tiles as per usual move rules") is read as "status/board resume, and
  ordinary play resumes going forward", not "the very next move on a mathematically stuck board
  must succeed"; the check demonstrates the letter of that (unchanged board, playing status) on
  the deadlock game, and separately demonstrates a real subsequent move working normally on a
  second game revived from the "give up" transition instead.
- **Case 1 also affects the create form.** The format has one field list per entity (`Entity.form`),
  shared by create and edit, so hiding `board`/`score`/`won`/`draws` from the create screen (to
  avoid asking a new player to type a raw board) would also remove the edit-route lever the two
  checks above rely on. Traded the other way: the real "New Game" UX never renders that form at
  all — `pages[].actions: ["newGame"]` posts a global action that inserts the row (its
  `Game.created` event seeds the two starting tiles — round 5, see New for this app) and redirects
  straight to `/Game/{created}` — so a player only meets the raw fields if they navigate to
  `/Game/new` by hand.

## Misses

- `composition` — no per-view field list (create vs. edit) on `Entity.form`; see the case-1 note
  above.
- `node kind` — no native "shuffle/array" field kind; the board lives in a plain `text` field as
  16 comma-separated ints, decoded/encoded by the plugin.

## New for this app

- A widget (`game2048`) with on-screen direction buttons *and* arrow-key handling, following
  apps/tictactoe's client contract (`mountWidgets`, `api.post`, re-render from the JSON answer).
- Round 5 lets `db.createRow` fire the created entity's own event from *any* block, not just the
  HTTP form route — closing the "insert then compute from the row's own new id" Miss this app used
  to record. `newGame` is now a plain global action (`db.createRow` on `Game`, declared literal
  defaults) plus a `Game.created` event (`game2048.seedTiles`) that places the two starting tiles —
  the current row in that event *is* the freshly-minted game (same "the current row is the new
  row" shape apps/cleaning's booking-reference event uses), so the one hand-written
  insert-and-mutate block is gone in favour of the same create-then-event idiom apps/chess and
  apps/poker already used for their own setup. (The PRNG placement math itself still has to be a
  plugin block either way — no expression can seed a random draw — so this is a graph-shape win,
  not a "no more plugin code" one.)
- An `Entity.updated` event driving a "recompute derived status from stored data" block
  (`game2048.sync`), used both after every real move and after a direct test-setup edit.
- id-seeded deterministic PRNG (`mulberry32` keyed by `id`, advanced by a persisted `draws`
  counter) as the concrete instance of docs/FORMAT.md's "Deterministic randomness" guidance;
  `checks.mjs` imports the plugin's pure functions as an oracle for the live HTTP assertions,
  plus one hand-computed slide/merge example per direction that is independent of trusting that
  shared code.
- The Round-4 widget-app rule ("at least one check drives the real widget in a real browser and
  confirms the server changed") is folded into the "Move Tiles Up" case rather than kept as a 9th
  array entry, so checks.mjs still has exactly one entry per ui_instruct case.
