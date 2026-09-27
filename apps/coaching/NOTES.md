# coaching — webgen-bench/000058

## Weakened cases

- **Case 1 (assessment) / Case 2 (profile).** `ui_instruct` orders "complete the assessment"
  before "update the profile", but an assessment needs a profile row to hang its answers off.
  Case 1's run therefore also registers the account and creates the profile (that part is setup,
  not assertion); case 2 exercises the actual edit path against the profile case 1 already made,
  which matches its own wording ("examine profile *creation* by *updating*").
- **Case 3 ("inputting" criteria).** As in `apps/studentportal`: the criteria are the profile's
  own fields (goal area) plus the assessment's derived type; "inputting" them is completing the
  assessment and setting the goal area, not a scratch query form. Suitability is a derived field,
  re-read fresh on every request, never stored.
- **Case 4 ("added to calendars").** There is no calendar view — a `Session` row shown on two
  different own-scoped lists (the client's `/Session`, the coach's `/Session`, same route,
  filtered by whichever `own` field matches the viewer) stands in for "both calendars".

## Misses

- `block` — same gap as `apps/attendance` and `apps/studentportal`: no block updates an arbitrary
  already-resolved row, only the current action/transition row (`db.update`) or the current row's
  *own* numeric field on another entity by id (`db.adjust`). It didn't bite this app as hard,
  because `db.each` + `db.ensure` (idempotent creation) was enough for the matching join table.
- `function` — no "which of these numbers is biggest, and what do I call it" primitive
  (`max(a, b)` takes two numbers and returns a number, not a label); classifying the assessment
  into one of four named types needed the plugin's `discType`.
- `composition` — a transition's `fields` become required stored columns the moment the graph is
  read (they are real fields of `ClientProfile`, always present, not scoped to "only meaningful
  after the assessment"), so `q1..q4` show up as ordinary int fields with a `def` of 3 rather than
  "unanswered until completed". Harmless here since the derived `profileType` is only surfaced
  once `assessmentStatus` reads `completed`, but it does mean the raw answers are visible (to the
  client and to admin) before that.

## New for this app

- A **state transition doubling as a multi-field form**: `fields: ["q1","q2","q3","q4"]` on
  `submitAssessment` is the only way in this format to ask for more than one value in a single
  guarded step (`db.update` applies them to the row *before* `do` runs, so `{row.profileType}` in
  `confirm` already reflects the just-submitted answers).
- Two-hop step-value resolution used deliberately: `"to": "@row.user.email"` inside an action
  whose own row (`CoachProfile`) is one hop from the address the mail actually needs (`User`) —
  `store.ctx(...).get(path)` resolves an arbitrarily long reference chain at *run time* even
  though a *declared* expression (a derived field or a rule) is statically limited to one hop.
- The `studentportal` matching shape (own-scoped join entity, self-populating via a pair of
  mirrored `X.created` events, plugin-scored, differentiated with a derived bool) reused for a
  different domain with a different score formula — evidence the shape is a pattern, not a
  one-off.
