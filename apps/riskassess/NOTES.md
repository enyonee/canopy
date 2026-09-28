# riskassess — webgen-bench/000084

## Weakened cases
- Case 1 ("select risk assessment items... clearly highlighted or checked"): there is no
  multi-select/checkbox-list field kind. "Selection" is modelled the way every other app in this
  format models a cart/line-item (`shop`'s `OrderItem`, `fooddist`'s `Application`): an inline
  related-add form on the assessment picks one `RiskItem` at a time from a `<select>`, and the
  item then appears as a row in "Selected risk items" — present in that table *is* the
  highlighting; there is no independent checkbox state to toggle.
- Case 3 ("charts... after selecting risk assessment items"): the chart is the site-wide
  `/dashboard/risk` breakdown by category, not a chart scoped to one assessment — a dashboard
  chart's `where` cannot be parameterised by an arbitrary row chosen in a UI flow (only fixed
  values, `"@me"`, `"@today"`). The check proves the chart is real and reactive (a fresh category
  appears with the exact right number the instant an item is selected), just not private to one
  assessment.
- Case 4 ("a downloadable report... including... generated charts"): a CSV cannot embed an SVG.
  The "report" is composed of three honest pieces instead of one file: the assessment's own
  derived totals (item count, total/average risk score — the report row itself), a CSV download
  of its selected items (`GET /AssessmentItem.csv?assessment=<id>`, using the generic entity-list
  CSV export plus a `ref` filter), and the dashboard chart. See Misses.

## Misses
- `node kind`: no document/report-generation node (no way to bundle a chart image and a table
  into one downloadable file); no dashboard parameterised by a row picked at request time.
- `field kind`: no multi-select/checkbox-group field kind for "pick several from a catalog" in
  one form submission — each pick is its own POST (line-item pattern), which is correct and
  auditable but is N requests instead of one.

## New for this app
- A "subscription" modelled as plain `roles` self-registration (`register: "subscriber"`) with
  immediate, ordinary permission grants — no payment plugin needed since the brief only asks for
  granted access, not a charge.
- Auto-population purely through one-hop derived fields on a join-table entity
  (`AssessmentItem.likelihood/impact/category/riskScore/guidanceNote := riskItem.*`): choosing the
  `ref` is the only input, every other field is computed from the "background database"
  (`RiskItem`) on the same request, so there is no separate fetch and no possible drift between
  the catalog and what a report shows.
- The generic per-entity CSV export (`/Entity.csv`, not just `/list/<id>.csv` /
  `/dashboard/<id>.csv`) combined with a `ref` filter, used as a filtered, downloadable report.
