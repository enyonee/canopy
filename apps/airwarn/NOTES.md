# airwarn — webgen-bench/000068

## Weakened cases
- Colour: the brief names "azure mist", which is not a CSS colour keyword; the nearest real one
  is `azure` (a very pale cyan), used here and asserted by `colorCheck`.
- Case 2 (AQI "refreshes automatically... without manual page reloads"): the dashboard uses
  `refresh: 10` (a full-page `<meta>` reload), not a client-side poll; the check triggers
  `POST /schedule/tick/run` by hand instead of waiting on the timer, as Round-4 prescribes.
- Case 4 ("select two different dates... see a visual comparison"): there is no two-date picker;
  both chosen dates are read off the *same* trend chart narrowed to span them — a real,
  accurate comparison, just not a dedicated side-by-side widget.

## Misses
- `node kind`: no client-push/poll primitive (same gap as `solardash`); `refresh` is the only
  self-updating affordance a plain scaffold page has.
- `composition`: a chart has one `groupBy`/`groupUnit`, so "compare two dates" is expressed as
  "narrow the same time-series chart to a range spanning both dates" rather than a dedicated
  two-column comparison view.

## New for this app
- Same deterministic-schedule idiom as `solardash` (`db.each` over a one-row singleton, snapshot
  into a history entity, then evolve four fields each by its own fixed sign-flipping step) —
  reused unchanged across a different domain (weather/AQI instead of solar), evidence the pattern
  generalises rather than being solar-specific.
- A derived `text` field categorising a numeric reading into bands via nested `if` (`category`:
  Good/Moderate/Unhealthy from `aqi`) — the same "transparent formula" technique as `stockreports`'
  trend and `hoopsbets`' prediction, applied to a threshold classification instead of a comparison.
- 14 days of seeded history plus live schedule ticks feeding the *same* entity and the *same*
  chart, so "the last two weeks" and "what just came in" are one continuous view, not two
  disjoint data sources glued together in the UI.
