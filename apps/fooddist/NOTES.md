# fooddist — webgen-bench/000082

## Weakened cases
- Case 4 (edit account contact details): the member edits a `Profile` row (phone, address, dietary) that an event creates on registration, not the `User` row itself. Reason: a form's field set cannot differ per role, so keeping `role` on the admin's user form (needed for the role change) would let a member promote themselves; splitting contact details into an owned `Profile` keeps the role field safe. The login email and name are therefore not editable by the member.
- Case 5 (header navigation): `navCheck(4)` walks the menu as the signed-in member from the previous case; the guest and admin menus are not walked separately.

## Misses
- `composition`: round 5 added `Entity.form.byRole` (a form's field list can now differ per
  role), but it does not actually close case 4's own workaround: byRole only varies which
  *fields* a form shows, not which *rows* a role may reach, and `own` still cannot scope "this
  row's own id equals the session user" for the login entity itself acting on its own rows (the
  same still-open limitation apps/social and apps/matrimony's own NOTES record) — granting
  `member` any `edit` on `User` without that scoping would let a member edit *any* user's row, not
  only their own. The owned `Profile` split stays the correct design, not a workaround for a
  now-closed gap.

## New for this app
- Round 5's `db.set` (update an arbitrary row named by `entity`+`id`, not only the current one)
  closes the "no step updates a referenced row" Miss: the `Application` transitions `approve`/
  `deliver` now each carry a `db.set` step (`{"entity":"Donation","id":"@row.donation","set":
  {"status":"claimed"}}` / `"distributed"`), so approving or delivering an application updates its
  own donation's status automatically — the "mark the donation claimed" example the Miss itself
  named. `checks.mjs`'s coordinator-role change confirms both transitions actually move the
  referenced `Donation`, not just the `Application` doing the transitioning.
- Correlated aggregate over an entity with no reference to the outer one: `Profile.applications := count(Application: applicant = row.user)`.
- A rule that hops through a reference to a derived field: `Signup` check `opportunity.open > 0`.
- `Entity.list.where` as the public view plus an admin saved list with `create: true` and filters; `createTitle`, `confirmEdit`, `afterEdit`; `pages[].links`; a row action with `after: "/Opportunity/{id}"`; an event on the user entity (`User.created` → `db.createRow`).
