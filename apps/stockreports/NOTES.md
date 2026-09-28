# stockreports — webgen-bench/000001

## Weakened cases
- Case 2 (report formats/content options): "format" is a fixed three-value enum
  (summary/detailed/full) rather than free-form layout choice; it changes nothing about the
  generated content today (see Misses) but is offered and stored.
- Case 5 (navigate and click every button back to the homepage): asserted with `navCheck`, which
  walks the top menu, not literally every button on every page.

## Misses
- `composition`: `Entity.form.confirm` has no `{row.*}` interpolation (only actions/transitions'
  `confirm` does, per `docs/FORMAT.md`'s Actions section) — a create's flash is a static string.
  Landing on the created row needs an explicit `"after": "/Entity/{id}"` (undocumented as the
  default; the default `after` is the list, not the row, unlike what `{created}`/`{id}` in
  `after` might suggest at first read).
- `field kind`: no native "percent"/ratio kind (shop's plugin `percent` field is app-local); a
  derived percentage has to be coaxed to `money` kind by dividing a `number` by a `money` (see
  `changePct`) since `money / money` is explicitly demoted to `number` and a derived field must
  match one of a fixed set of kinds — one level of algebra surprise, not a blocker.
- `format` currently only labels a report; there is no per-format template (e.g. "full" pulling
  in extra sections beyond trends/financials) — out of scope for what the six cases ask.

## New for this app
- A derived `money` field built from `money / money` and `number * money` combined so the
  expression's inferred kind matches the declared field kind (`changePct`).
- A derived `text` field that summarises another entity's derived fields through a one-hop
  reference plus conditional `concat`/`if` composition (`Report.content`), directly implementing
  the brief's "report row whose derived fields summarise its inputs".
- A dashboard `bar`/`pie` chart pair over a non-enum, non-ref `groupBy` (a plain required `text`
  field, `symbol`).
