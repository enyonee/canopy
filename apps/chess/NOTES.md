# chess — webgen-bench/000009

## Weakened cases

- **Case 1/7 (new game / difficulty).** The create form (`Game.form.fields: ["mode","difficulty","theme"]`)
  is the only way to submit a difficulty at creation time (a global action's page button carries no
  inputs — see docs/FORMAT.md's `pages[].actions`), so "New Game" goes through the standard entity
  create route rather than a bespoke widget flow. AI difficulty is proven honestly: "easy" is a
  uniformly random legal move, "hard" greedily takes the highest-value capture available (else
  random) — both one-ply, both stated as such, no real search. Perft-verified (20/400/8902 at depth
  1-3 from the start position) and confirmed to prefer captures correctly for every piece type,
  not only pawns (see Misses).
- **Case 4 (undo) against a genuine deadlock.** Undo restores the exact prior board — it does not
  invent a way out of a position that was never actually reachable, so undoing into a position with
  no legal continuation still has no legal continuation. Not exercised as a case (no ui_instruct
  case asks for it); noted for completeness.
- **Promotion** always defaults to a queen — the widget has no piece picker (click-to-move only
  sends `{from,to}`); the engine and the `move` action both accept an explicit `promotion` and are
  exercised that way by the checks that need it (perft/engine tests), just never from the widget's
  UI. A real, if minor, product gap rather than a runtime limitation.

## Misses

- `node kind` / `field kind` — no first-class board/matrix or FEN-like type; `fen` is a plain `text`
  field, decoded/encoded entirely by the plugin engine (`apps/chess/engine.mjs`).
- `composition` — one field list per entity form (create and edit share `Entity.form.fields`); this
  is why `mode`/`difficulty`/`theme` are the only Game fields ever exposed to a client at all —
  `fen`/`status`/`result`/`white`/`black` are never directly editable by any role (a deliberate,
  stronger choice than apps/game2048's board, which *is* left editable for test setup — chess's
  legality matters enough that every state change goes through `move`/`undo`/`join`/`resign`,
  verified end to end by playing real, engine-legal move sequences in the checks instead).
- `composition` — turn ownership ("only whoever's colour it is may move") is still real logic
  inside `chess.move` (`sameUser` against whichever of `white`/`black` the FEN's side-to-move
  names) — `own` grants a fixed per-row relationship, never a value that flips every ply, so this
  half of the old "no per-row multi-owner permission" Miss stays open. The other half ("only a
  player of this game may resign/undo/…") is closed — see New for this app.
- A step's `"from"` key is reserved for an entity name by the generic step checker
  (`runtime/check/steps.mjs`, shared by `db.each`/`random.pick`) — a block with its own "source
  square" parameter has to name it something else (`fromSq` here); recorded since it cost a
  checker error before the rename.

## New for this app

- A full legal-move chess engine as an app-local plugin's *pure* half (`apps/chess/engine.mjs`,
  intentionally outside `plugins/` — see its own header — imported by both the server blocks and
  by checks.mjs as an oracle): board representation, pseudo-move generation per piece, check/pin
  filtering, castling (both sides, through-check rules), en passant, promotion, and checkmate/
  stalemate as "no legal moves, in/not in check." Perft-verified against the standard counts.
- Two players + a seeded "bot" `User` row standing in for the AI opponent, so `white`/`black` stay
  uniform `ref:User` fields whether the opponent is a person or the computer.
- Round 5's multi-field `own` (`roles.can.player.Game: { "own": ["white", "black"], "can": [...],
  "all": ["view", "create", "go:join"] }`) closes half of the "no per-row multi-owner permission"
  Miss: `go:resign`/`do:move`/`do:undo`/`do:setDifficulty`/`do:setTheme` are now scoped, at the
  role-matrix level, to whichever two users a game's own `white`/`black` name — a third party gets
  a plain 403 before any block runs. `chess.resign` and `chess.undo` dropped their hand-rolled
  "you are not a player in this game" guard as a result (the route no longer reaches them for
  anyone else); `checks.mjs`'s resign case now asserts Bob is refused (403) on all three actions
  against Alice's game, which — tellingly — includes `setDifficulty`/`setTheme`, two actions that
  had *no* per-row guard at all before (only `resign`/`undo` ever hand-checked "are you a player");
  `own` closes a real gap here, not just a cosmetic one. Turn ownership itself is unaffected — see
  Misses.
- Round 5 also lets `db.createRow`/`db.create`/`db.ensure` fire their entity's own `created` event
  from any block, closing the general "db.createRow never fires created" miss this app used to
  record. Game creation is unchanged: it already went through the standard `Game.form` (a typed,
  validated create form for `mode`/`difficulty`/`theme`) whose route fired `Game.created` before
  this round too, so `chess.setupGame` needed no rewrite.
- Round 5 also lets a widget `prop`'s value be `"@row.field"`, resolved server-side — closing the
  general "a declared widget prop is never resolved against the row" Miss this app used to record.
  `chess`'s own widget still declares no props and reads everything off `data-row` instead: the
  client needs `fen`, `mode`, `difficulty`, `theme`, `status`, `endReason` and `result` all at
  once, and `data-row` already carries the whole row for free — naming each one as an individual
  `prop` would duplicate, not simplify, what one `"widget": { "use": "chess" }` already gets it.
- A real-browser widget check (Round-4 rule for widget apps) folded into the "Theme" ui_instruct
  case: it clicks a real move on the board *and* the theme control in one browser session, so the
  "board stays fully playable after a theme change" half of the expected result is actually
  exercised, not merely asserted.
- Deterministic AI: `pickAiMove(fen, difficulty, gameId, ply)` is seeded by `(gameId, ply)`, so
  checks.mjs predicts the bot's exact reply (board and all) after every human move — the same
  "deterministic randomness" pattern as apps/game2048, extended to a difficulty-dependent choice
  instead of a plain shuffle.
