# studentportal — webgen-bench/000057

## Weakened cases

- **Case 1 (registration → profile).** Registering creates the `User` account; a second,
  immediate step creates the `StudentProfile` row (own-scoped, `fill`-free — the account is
  filled by `own`). "Successful registration leads to the creation of a new student profile" is
  a two-request flow, not one atomic step — the format's `/register` route has a fixed redirect
  and cannot itself run a second entity's create form.
- **Case 3 (matching by "inputting" criteria).** The criteria are the student's own profile
  fields; "inputting" them is editing the profile (case 2), not a scratch form that takes
  one-off values without saving. The match list re-scores against the *current* profile on every
  read (the score is a derived field, never stored), so an edit is visible immediately.
- **Case 4 (application "step-by-step... intuitive").** Applying is a single row action
  (`Provider.detail`'s "Apply" button) with a confirmation; there is no multi-step wizard — the
  scaffold offers one screen per entity, not custom flows.
- **Case 5/7 (provider access / communication).** "Predefined criteria" are the provider's own
  profile fields (the same scoring the student side uses, symmetrically); "direct communication"
  is a message thread nested under the match (`apps/qna`'s answer-under-question shape, reused
  for a two-party thread instead of one-to-many).

## Misses

- `composition` — `own` must be a direct `ref:User` field, but the score expression needs a
  direct reference to the *profile* (to read its criteria fields, one hop only). Neither role's
  natural key (their profile) can serve both jobs, so `Match` carries two ref pairs per side
  (`studentUser`/`student`, `providerUser`/`provider`) — an owner column purely for permission
  scoping, denormalized alongside the display/scoring column. The same doubling recurs on
  `Application` (`provider` for display, `providerUser` for the provider's own-scoping).
- `block` — no conditional step, so a `StudentProfile.created`/`Provider.created` event can't
  special-case by role; this is why profile creation is its own entity/route per role rather than
  something a single `User.created` event could populate (a provider's account creation would
  otherwise also spawn a spurious `StudentProfile`, see `apps/fooddist`'s NOTES for the same
  shape of problem solved the same way — a dedicated owned entity, not a branch in an event).
- `field kind` / `function` — no ordinal comparison in the core algebra (only `=`/`<`/`>` between
  same-kind values, and enums compare only for equality); ranking "bachelor's ≥ associate's"
  needed the plugin. Matching on it is the one place this app couldn't have stayed inside plain
  expressions.

## New for this app

- Two events, each walking the *other* entity with `db.each` + `db.ensure`, so the join table
  (`Match`) between two independently-created entities self-populates from whichever side is
  created second, with no batch job and no duplicate rows (`db.ensure`'s idempotence).
- A derived field (`isMatch`) whose expression reads *another* derived field (`score`) on the
  same row — derivation composes, not just over stored columns.
- A single `roles.can` entity (`Match`, `Application`) scoped by a **different** `own` field per
  role, so one list/detail route serves two unrelated parties' opposite views with no branching
  in the graph.
- A plugin `function` whose arguments are all plain fields (no plugin `field` kind or `block`
  needed) — the smallest way to add one comparison the algebra can't express.
