# fooddist — webgen-bench/000082

## Weakened cases
- Case 4 (edit account contact details): the member edits a `Profile` row (phone, address, dietary) that an event creates on registration, not the `User` row itself. Reason: a form's field set cannot differ per role, so keeping `role` on the admin's user form (needed for the role change) would let a member promote themselves; splitting contact details into an owned `Profile` keeps the role field safe. The login email and name are therefore not editable by the member.
- Case 5 (header navigation): `navCheck(4)` walks the menu as the signed-in member from the previous case; the guest and admin menus are not walked separately.

## Misses
- `composition`: a form (`Entity.form.fields`) is the same for every role; there is no per-role field set.
- `block`: no step updates a referenced row (e.g. mark the donation `claimed` when an application is approved); `db.update` only touches the current row and `db.adjust` only int/money fields, so the donation status stays manual.

## New for this app
- Correlated aggregate over an entity with no reference to the outer one: `Profile.applications := count(Application: applicant = row.user)`.
- A rule that hops through a reference to a derived field: `Signup` check `opportunity.open > 0`.
- `Entity.list.where` as the public view plus an admin saved list with `create: true` and filters; `createTitle`, `confirmEdit`, `afterEdit`; `pages[].links`; a row action with `after: "/Opportunity/{id}"`; an event on the user entity (`User.created` → `db.createRow`).
