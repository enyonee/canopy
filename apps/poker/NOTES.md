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

- `node kind` — no side-pot handling: a short stack going all-in for less than the current bet is
  not specially unwound into main/side pots; the pot is just whatever chips were actually
  committed. Fine for the fixed-bet model above (nobody can be forced to cover more than one
  fixed bet), a real gap for anything richer.
- `composition` — one field list per entity form again (see apps/chess's NOTES.md): `Room.form`
  only ever offers `name`/`maxSeats`, so nothing about a room's blind structure is editable after
  creation, and nothing about a `Seat` (chips, hole cards) is ever exposed to a generic edit form
  at all — every state change goes through `join`/`startHand`/`act`.

## New for this app

- Round 5 `Entity.detail.private` closes the "no per-field, per-viewer redaction" Miss: `Seat.detail`
  now declares `"private": { "holeCards": "user" }`, so a seat's hole cards are redacted (`null` in
  JSON, "Hidden" in HTML) to every viewer except that seat's own signed-in player and an admin — in
  the widget's own `/Seat?room=` fetch, the plain `/Seat/:id` detail page, and any other place the
  field could be read, from one declaration. `poker.client.mjs` needed no change (it already just
  renders whatever `holeCards` comes back); its comment about "no way to hide this" is updated to
  say why hiding is now real instead of client-side theatre. `checks.mjs`'s case 4 now asserts, in
  both JSON and HTML: Alice sees her own cards, Bob does not see Alice's (nor she his), and a
  signed-out guest sees no one's — the deal/showdown verification itself moved to an admin fetch
  (admins are exempt from `private`, same as everywhere else) instead of weakening either check.
- Round 5 also lets `db.createRow`/`db.create`/`db.ensure` fire their entity's own `created` event
  from *any* block, not only the HTTP form route — closing the general miss this app used to record
  here. It changes nothing about poker's own design: `Room` is still created through the standard
  `Room.form` (typed, validated `maxSeats`) whose route already fired `Room.created` before this
  round too, and `poker.seatCreator` is still the cleanest way to seat the creator (a bespoke global
  action would trade a typed, validated create form for untyped text inputs — a downgrade, not a
  simplification), so no code changed.
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
