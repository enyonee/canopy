# calc — webgen-bench/000078

## Weakened cases

- **Case 2 (calculation type "visibly confirmed").** There is no live re-render on
  select: the type is confirmed by being shown, unchanged, on the result page after
  submit (`<th>Kind</th><td>scientific</td>`), not by an on-page indicator that
  updates before the form is sent.
- **Case 5 (navigation "smooth").** No client-side transition exists (there is no
  JS); "smooth" is read as "loads without error", i.e. a 200 with no broken link.

## Misses

- `node kind` — no accessibility audit tooling; not asked for by the format either.

## New for this app

- A plugin that owns the whole feature: `plugins/arith.mjs` registers two pure
  expression functions (`calc`, `isValid`), not a field kind or a block — a derived
  field (`result := calc(expression, kind)`) and a rule (`isValid(expression, kind)`)
  are enough to make "compute and refuse invalid input" closed-graph.
- A three-grammar calculator (basic / scientific / percentage) living entirely in
  the plugin; the graph only names the two functions.
