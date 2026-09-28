# solardash — webgen-bench/000006

## Weakened cases
- Case 1 ("continuously updating... without the need for a page refresh"): the dashboard uses
  `refresh: 10` (a `<meta http-equiv="refresh">` full-page reload every 10s), not a client-side
  poll/push. Checks trigger `POST /schedule/tick/run` by hand instead of waiting on the timer
  (`AG_NO_TIMERS=1` under verify), per the Round-4 addition.
- Case 5 (navigate between sections "without page reload issues"): each dashboard is its own page
  (an ordinary navigation, not an SPA tab switch); "without issues" is read as "no errors", which
  both checked sections satisfy.

## Misses
- `node kind`: no client-push/poll primitive; `refresh` is the only "this page updates itself"
  affordance for a plain scaffold page (a widget could poll via `api.get`, but no widget is
  needed here — this app has no interactive board/game, just numbers).

## New for this app
- First use of the `schedule` node kind for genuinely deterministic "real-time" data: a single
  `db.each` (over a one-row singleton "Station" entity) whose nested steps first snapshot the
  current values into a `Reading` history row, then evolve the singleton by a fixed, sign-flipping
  step (`if(each.field >= ceiling, -down, +up)`, with `db.adjust`'s own `min` as the floor) — so
  `N` calls to `POST /schedule/<name>/run` produce a value a check can predict exactly by
  replaying the same arithmetic, per the brief's "deterministic randomness" guidance generalised
  from games to sensor readings.
- A dashboard card whose `entity` is a one-row singleton, used purely to display "the current
  value" (not really an aggregate) — `fn: "avg"` over one row is just that row's value.
