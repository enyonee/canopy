# nutrition — webgen-bench/000063

## Weakened cases

- **Case 3 (packaging design).** "Design your own food packaging" becomes a form whose fields
  *are* the Canadian-regulation compliance choices (packaging material, bilingual/English/French
  labelling, net-quantity declaration, allergen statement), plus a derived `bilingualCompliant`
  flag. There is no visual/drag-and-drop package mock-up — the runtime has no canvas or design
  surface, only data forms.
- **Case 6 (keyboard navigability by tabbing through the homepage).** There is no browser in the
  check harness, so tab order and focus cannot be observed over plain HTTP. Weakened to
  `navCheck`: every nav item is a plain `<a href>` (natively focusable, no `tabindex="-1"`, no JS
  focus traps) and every one of them resolves with 200.

## Misses

- `node kind` — no chart/graphic node: the "Nutrition Facts" table is a plain HTML table of
  labelled rows (Canada's real label is a specific bordered graphic layout), and the derived
  vitamin/mineral fields are shown as plain numbers, not %DV bars.
- `node kind` — no design canvas for the packaging tool (see Weakened case 3).
- `composition` — a browser-only concern (tab order, focus rings) is unobservable from an HTTP
  check; there is no in-repo browser tool for this benchmark run.

## New for this app

- A parent/child pair with no login at all (`Analysis` + `AnalysisItem`, `PackageDesign`): every
  visitor's session is anonymous, so "start a new analysis" and "design a new package" are just
  ordinary creates with no owner field — the simplest possible reading of "no accounts mentioned".
- A derived sum whose body scales a referenced row's stored field by a same-row stored field and
  a second referenced field in one expression: `sum(AnalysisItem: food.calories * grams /
  food.servingGrams)` — proportional scaling (grams eaten ÷ grams per label serving) rather than
  a flat unit price/qty multiply.
- `text=<value>` default (`title: "text=Untitled analysis"`) on a row with no other identifying
  text field, so a visitor who skips naming their analysis still gets a sane list label.
