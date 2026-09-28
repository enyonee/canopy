# policies — webgen-bench/000005

## Weakened cases
- Case 1 (visualization "for a selected regulatory policy"): there is no per-row, dynamically
  parameterised dashboard; the check instead opens the policy (selects it) and confirms the
  *general* policy dashboard's bar chart carries that exact policy's own value — a real,
  accurate chart, just not one scoped down to only the selected row.
- Case 4 (navigation with "the current section clearly indicated"): asserted through each
  section's own `<title>` (Policies / Policy analytics), not a highlighted nav item — the
  scaffold's nav has no active-link state.

## Misses
- `node kind`: a dashboard chart/table cannot be parameterised by an arbitrary row picked at
  request time (only fixed `where`, `"@me"`, `"@today"`); "the chart for whichever policy the
  visitor just opened" is not directly expressible without one dashboard per row.
- `composition`: `Entity.detail.fields` is a *filter* over the entity's declared field order, not
  a reordering directive — the detail table always shows fields in `data` declaration order
  regardless of the order named in `override`. Worth a line in `docs/FORMAT.md` since it reads as
  if it might reorder.
- `field kind`/`composition`: a non-state-machine `enum` field (no `states` entry for the
  entity) renders its raw lowercase value, not the capitalised `<span class="status">` styling a
  state-machine status field gets — fine here, just notes the two render differently.

## New for this app
- Three filter kinds on one list at once: an enum filter (auto options), a date `range` filter,
  and an int `range` filter (`relevanceScore_from`/`_to`) used for a plain non-monetary metric.
- A `PolicyMetric` child feeding both a `detail.related` table ("related data") and its own
  dashboard `line` chart grouped by a plain `int` (`year`, no `groupUnit` needed since it is
  already a bucket, not a date).
