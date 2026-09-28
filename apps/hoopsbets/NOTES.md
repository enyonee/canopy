# hoopsbets — webgen-bench/000004

## Weakened cases
- Case 4 (rankings with "clear markers indicating any ties"): there is no rank/window function
  (no `argmin`/dense-rank in the expression algebra — a known gap from round 2), so a tie is
  shown the honest way a plain sorted table can show it: two teams with the identical win
  percentage sit adjacent after sorting by `winPct desc`, rather than an explicit "T-3" badge.
- Case 3 ("search... find a specific team's historical match data"): search only works over a
  stored (non-derived) text column, so `Match` carries a denormalised `teams` field
  (`"Ironclads vs Comets"`) purely so `?q=` can match either side; the two `ref` fields
  (`homeTeam`/`awayTeam`) still hold the real, checked relationship.

## Misses
- `block`/`function`: no ranking/`argmin` aggregate — "which row is best/worst within a group" or
  a dense rank column has to be read off a sorted list instead of stored/labelled.
- `composition`: `list.search` is documented as matching "stored text fields", which rules out
  searching by a ref's target name (e.g. by team) without a denormalised text column; every
  round-2/3 app that needed this hit the same wall (see `REPORT.md`'s tally).

## New for this app
- A three-level derived chain across an entity boundary: `Match.recommendation` reads
  `Match.predictedAwayWinPct` (derived), which reads `Match.predictedHomeWinPct` (derived), which
  one-hops into `Team.winPct` (itself derived) on *both* referenced rows (`homeTeam.winPct`,
  `awayTeam.winPct`) — confirms a one-hop reference may land on a derived field of the target
  entity, not only a stored one.
- The "transparent formula" pattern the brief asks for: `predictedHomeWinPct` is plain,
  auditable arithmetic (50 base + half the win-% gap + a fixed 5-point home edge, clamped 5-95
  with `min`/`max`) — never a plugin, never a black box; `recommendation` is an `if`/`concat` of
  that same number, so the advice and the statistic that backs it are the same computation.
- `int :=` derived from `round(x)` where `x`'s inferred kind is `number` (matching `int`'s
  `exprKind`), alongside `stockreports`' `money :=` case, for contrast: a derived field's declared
  kind must match the expression's inferred kind exactly, not just "some number".
