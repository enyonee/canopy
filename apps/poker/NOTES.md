# poker — webgen-bench/000007

## Weakened cases

- **Betting is a single fixed bet per street, not free-form raising.** Actions are `fold` / `check`
  / `call` / `bet` (a fixed bet = the room's big blind); once someone bets, everyone else may only
  call or fold — no re-raise. This is a real, working round of betting (blinds, action order,
  street-by-street pot growth, all-in-for-less short stacks are *not* handled — see Misses), just
  not the full no-limit sizing model. Stated here rather than silently narrowed.
- **Case 4 (play a round).** Exercised with exactly two seats (heads-up) so the check can predict
  and drive every single action itself; 3+ handed tables work identically (smoke-tested by hand —
  dealer rotation, blind assignment and bots all behave the same way for N=3, see the manual runs
  in this app's development), just not asserted turn-by-turn in `checks.mjs` for brevity.
- **Case 5 (game records / statistics).** "Game records" is `User.handsPlayed`/`handsWon` on the
  profile page, not a hand-by-hand history list (no ui_instruct case asks for the latter — case 5's
  wording is "past game results and statistics", read as the aggregate stats, which the profile
  genuinely stores and updates after every hand). `Hand` rows *are* a real per-hand record
  (stage, pot, community cards, winner, winning hand name), reachable from a room's detail page —
  just not surfaced on the profile itself.

## Misses

- `field kind` / `composition` — **no per-field, per-viewer redaction.** Every seat's `holeCards`
  is a plain, fully-readable field: any signed-in player (or a determined guest calling the JSON
  API directly) can see every hand at the table, not only their own. `own` scopes a whole row to
  one owner, never a single field to "the viewer, if it's their row, else redacted" — there being
  no way to express that, the honest choice was to show hole cards openly to every viewer (the
  widget does this — see poker.client.mjs's own comment) rather than hide them client-side while
  the same data sits unprotected one fetch away. Documented, not quietly shipped as if secure.
- `composition` — same reason chess and game2048 hit it: a global action's `db.createRow` never
  fires the created entity's `created` event, so seating the room's creator has to ride the
  standard entity-create route + a `Room.created` event (`poker.seatCreator`) instead of a single
  atomic "create the room" action.
- `node kind` — no side-pot handling: a short stack going all-in for less than the current bet is
  not specially unwound into main/side pots; the pot is just whatever chips were actually
  committed. Fine for the fixed-bet model above (nobody can be forced to cover more than one
  fixed bet), a real gap for anything richer.
- `composition` — one field list per entity form again (see apps/chess's NOTES.md): `Room.form`
  only ever offers `name`/`maxSeats`, so nothing about a room's blind structure is editable after
  creation, and nothing about a `Seat` (chips, hole cards) is ever exposed to a generic edit form
  at all — every state change goes through `join`/`startHand`/`act`.

## New for this app

- A second from-scratch pure engine (`apps/poker/engine.mjs`, same "kept out of plugins/, imported
  by both the server and checks.mjs" shape as apps/chess/engine.mjs): a seeded Fisher-Yates shuffle
  and a real 7-card-down-to-best-5 hand evaluator covering all nine standard categories including
  the wheel (A-2-3-4-5) straight, hand-verified against known category examples before being wired
  into the app.
- Bots that act immediately, in the same request, for as many consecutive turns as it takes to
  reach the next human (or the end of the hand) — the same convention as the AI reply in
  apps/chess and apps/game2048, extended here to a whole betting round instead of one move.
- A related child table used as a genuine chat log (`Chat`, `via: room`, `fill` supplying both the
  author's id and a display label) — "chat as rows" from the brief, with no bespoke action needed
  at all: the built-in related-add route already does exactly this.
- A `?room=` list filter on two hidden entities (`Seat`, `Hand`) purely so the widget's own
  `api.get` calls can scope to one table — the same trick chess's Move history needed.
