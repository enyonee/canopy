# neighborhoods — webgen-bench/000002

## Weakened cases
- Case 2 (select and compare two neighborhoods): "select" is a shared-city search (`?q=`)
  narrowing the list to exactly the two neighborhoods that happen to share a city, not a
  dedicated two-item picker; both then appear as adjacent rows with every demographic column
  visible, which is the comparison itself.
- Case 4 (rearrange components, save the layout): there is no node kind for a user-driven,
  persisted dashboard layout (drag-and-drop, column reordering saved per viewer). The closest
  honest thing is a second, precomputed `dashboards[]` entry (`areas-swapped`) with the
  demographic and economic tables in the opposite order, reached by a "Swap layout" link — a
  real alternate layout that is *served*, not one the visitor *built and saved* live. See Misses.

## Misses
- `node kind`: no dashboard-layout/composition node — a viewer cannot reorder or hide a
  dashboard's own cards/tables/charts and have that choice persist; every layout is authored in
  the graph. `pages[].sections` (closes "embed a saved list on a page") does not cover this
  either — it is about content, not about a viewer rearranging existing panels.
- `composition`: dashboard `period` is one date/time field per entity; using it for a mostly
  static reference table (each neighborhood surveyed once) makes "time range" mean "which
  neighborhoods were last surveyed in this window" rather than a true historical trend — honest,
  but a stretch of what `period` was built for (recurring transactional rows like orders).

## New for this app
- A `filters[]` entry on a plain required `text` field (`city`) with an explicit `options` list
  (the checker refuses a text filter without one — options are derived automatically only for
  `ref`/`enum`/`bool`); same technique `travel` used for cities in round 2.
- Two dashboards sharing the same `period` entity/field and the same chart set, differing only in
  table order, used to demonstrate a swappable layout without a real layout node.
- A `line` chart grouped by a `date` field with `groupUnit: "month"` whose count changes visibly
  under a narrowed `from`/`to` — read directly from the chart's own `<table class="chart-data">`
  rather than the SVG.
