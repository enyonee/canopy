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

- `block` — no conditional step, so a `StudentProfile.created`/`Provider.created` event can't
  special-case by role; this is why profile creation is its own entity/route per role rather than
  something a single `User.created` event could populate (a provider's account creation would
  otherwise also spawn a spurious `StudentProfile`, see `apps/fooddist`'s NOTES for the same
  shape of problem solved the same way — a dedicated owned entity, not a branch in an event).
- `field kind` / `function` — no ordinal comparison in the core algebra (only `=`/`<`/`>` between
  same-kind values, and enums compare only for equality); ranking "bachelor's ≥ associate's"
  needed the plugin. Matching on it is the one place this app couldn't have stayed inside plain
  expressions.

- `composition` (own in two hops): a message belongs to the two users of its match, but they sit two hops away
  (`Message.match → Match.student → StudentProfile.user`, likewise through `provider`), and `own` takes a
  direct field or one hop only. Worked around by keeping the two owners on the match itself: `Match.studentUser`
  and `Match.providerUser` are stored `ref:User` copies, written only by the server: the seed, and `Match.created`/`Match.updated` events that
  re-derive both from `student.user`/`provider.user` after every create and form edit, so whatever a request
  posts for them (even an admin's `POST /Match`) is overwritten in the same transaction; every match the
  profile events make with `db.ensure` fires `Match.created` too. `StudentProfile.user`/`Provider.user` are on
  no form, so they never change over HTTP. Check 7 posts forged copies as the admin, on create and on edit,
  and asserts they are replaced. Students and providers
  may not create or edit a Match at all. A two-hop `own` ("match.student.user") would make the copies
  unnecessary — a candidate for the format.

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
- Round 5: `own` may now be a one-hop path, closing the "owner column purely for permission
  scoping, denormalized alongside the display/scoring column" Miss above. `Match.student`/
  `Match.provider` (needed for the score expression's one-hop reads) are now *also* the own
  paths: `student.user` / `provider.user`, not a second `studentUser`/`providerUser` field
  duplicating what the display column already names. `Application` drops its `providerUser`
  the same way (`provider.user`); `student` there was already a direct `ref:User`, unaffected.
  Two real fields instead of four, one meaning each.
- Messages are private to their match: `Message` is granted with the single path `own: "match.studentUser"` to
  students and `own: "match.providerUser"` to providers. Before, it was granted without `own`, so any student or
  provider listed and opened every conversation through `/Message` (JSON), and a direct `POST /Message` could
  name anyone as `sender`. `sender` is not an own path on purpose: the runtime accepts a write when *any* own
  path matches, and a sender filled from the session always matches, so a student could post into a match that
  is not theirs. The sender is set by `fill: {"sender": "@me"}` instead — on the match page's related form and on
  `Message.form` (fields `match`, `body`) for a direct `POST /Message`; with SEC3 the runtime also checks that
  the new message's match is the poster's. Check 7 asserts that
  Alice and HealthBridge read none of Maria's thread with TechForward and that a posted `sender` is ignored.
