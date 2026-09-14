# calls — webgen-bench/000022

## Weakened cases
- Case 1 (client creator wizard): a wizard is a multi-step form; the format has one-page forms only, so the "wizard" is a single form with an intro. The check tests one submission, the confirmation and the list.
- Case 7 (report "available for download or viewing"): viewing only — the report is a dashboard with cards, grouped tables and a period filter; nothing can be downloaded. The check tests the figures and the period filter, not a download.
- Case 6 (to-do calls): "to-do" is modelled as a status (`todo`, reached by the "Needs follow-up" transition that asks for a date) plus a saved list sorted by that date; the original wording does not say what makes a call a to-do.

## Misses
- `node kind`: multi-step wizard (a form split into steps with per-step validation).
- `node kind`: report export (CSV/PDF download or print view of a dashboard).
- `node kind`: per-field, per-role form control — the agent field is hidden from the edit form for everyone because a field cannot be editable for admins only; permissions are per entity and operation.

## New for this app
- `lists[].sort` and `go:<transition>` buttons inside a saved list (shop/crm lists used only view/edit).
- `createTitle` and `intro` on a form to name the wizard; `confirmEdit` + `afterEdit` landing on the edited row's profile.
- An aggregate with a string comparison (`count(CallLog: status != 'closed')`) and a rule mixing an enum test with a null test (`kind = 'action' or due != null`).
- Dashboard tables grouped by two different references (`agent`, `client`) with `sort` on the count metric.
