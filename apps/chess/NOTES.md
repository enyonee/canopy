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
- `block` — a global action has no way to create a row and then act further "on" that new row in
  the same step list (`db.create`/`db.createRow` expose only `@created`'s id, not a row the
  following steps run against) — this is why game creation goes through the standard entity form
  + a `Game.created` event (`chess.setupGame`) instead of a bespoke "new game" action the way
  apps/game2048 had to hand-roll one block that both inserts and mutates by its own id.
- `composition` — one field list per entity form (create and edit share `Entity.form.fields`); this
  is why `mode`/`difficulty`/`theme` are the only Game fields ever exposed to a client at all —
  `fen`/`status`/`result`/`white`/`black` are never directly editable by any role (a deliberate,
  stronger choice than apps/game2048's board, which *is* left editable for test setup — chess's
  legality matters enough that every state change goes through `move`/`undo`/`join`/`resign`,
  verified end to end by playing real, engine-legal move sequences in the checks instead).
- `composition` — no per-row multi-owner permission (a "this row belongs to either of two users"
  grant); `own` only names one ref field. Turn ownership ("only whoever's colour it is may move")
  and "only a player of this game may resign/undo" are therefore real logic inside the blocks
  (`sameUser`), not expressible in `/roles`.
- A step's `"from"` key is reserved for an entity name by the generic step checker
  (`runtime/check/steps.mjs`, shared by `db.each`/`random.pick`) — a block with its own "source
  square" parameter has to name it something else (`fromSq` here); recorded since it cost a
  checker error before the rename.
- A declared widget `prop` is never resolved against the row (`"fen": "@row.fen"` would reach the
  client as the literal string `"@row.fen"` — `runtime/render.mjs`'s `widgetBlock()` only strips
  `use` and JSON-stringifies the rest); every per-row value has to travel through `data-row`
  instead, same as apps/tictactoe's `ttt` widget. Cost a design iteration here (see chess.mjs).

## New for this app

- A full legal-move chess engine as an app-local plugin's *pure* half (`apps/chess/engine.mjs`,
  intentionally outside `plugins/` — see its own header — imported by both the server blocks and
  by checks.mjs as an oracle): board representation, pseudo-move generation per piece, check/pin
  filtering, castling (both sides, through-check rules), en passant, promotion, and checkmate/
  stalemate as "no legal moves, in/not in check." Perft-verified against the standard counts.
- Two players + a seeded "bot" `User` row standing in for the AI opponent, so `white`/`black` stay
  uniform `ref:User` fields whether the opponent is a person or the computer.
- A block that creates a row from a global action and, in the very next line, mutates that same row
  by the id it just returned (`db.createRow`'s `@created` isn't a row context — see Misses) —
  reused from the same pattern in apps/game2048.
- A real-browser widget check (Round-4 rule for widget apps) folded into the "Theme" ui_instruct
  case: it clicks a real move on the board *and* the theme control in one browser session, so the
  "board stays fully playable after a theme change" half of the expected result is actually
  exercised, not merely asserted.
- Deterministic AI: `pickAiMove(fen, difficulty, gameId, ply)` is seeded by `(gameId, ply)`, so
  checks.mjs predicts the bot's exact reply (board and all) after every human move — the same
  "deterministic randomness" pattern as apps/game2048, extended to a difficulty-dependent choice
  instead of a plain shuffle.
