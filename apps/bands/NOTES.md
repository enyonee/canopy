# bands — webgen-bench/000087

## Weakened cases

- **Case 1 (band registration).** Registration asks for name, email, password, bio, contact,
  a photo, an audio link and a YouTube link all at once, rather than a bare-bones sign-up
  followed by a separate profile-editing step — the format's `own` scoping ties view-scope to
  write-scope for one role/entity pair (see apps/qna, apps/fooddist), and letting a band edit
  its *own* row later would have required either exposing self-edit unscoped (any band could
  edit any other band) or scoping `User`'s view to "own row only" (which would have hidden
  every other band from the public directory). Capturing everything at registration sidesteps
  the conflict entirely, honestly, rather than granting an edit right we could not scope.
- **Cases 3–5 (picture/audio/video "upload").** The top-level instruction says bands
  "provide picture links and audio sample links" and "direct links to YouTube videos" — plain
  URLs. `photo` is implemented as a real `image` upload (closer to what the per-case expected
  results ask, "accepts image files and displays the uploaded image", and the format has a
  real file store to back it), while `audioUrl` and `youtubeUrl` stay plain text fields,
  since there is no audio player or video-embed primitive in the format (see Misses).
- **Advertiser registration (case 6).** There is only one `roles.register` target ("band"),
  so the advertiser sign-up is the entity's own create form at `/User/new`, gated open to
  `guest` and pinned to `role: "advertiser"` via `fill` (which the visitor cannot override
  because `role` is not in the form's field list). This is a second, independently honest
  registration path the format allows, not a hack: `register` and a role-gated entity-create
  form are two different built-in mechanisms. **Bug fixed this round:** `User.form` was
  missing that `fill` entirely — every `/User/new` signup (this app's real behaviour, not
  this file's prior description of it) silently landed on the field's plain default, "band",
  so no advertiser account this app ever created through the sign-up form actually held the
  "advertiser" role; `checks.mjs`'s own follow-up "place an ad" assertion masked this (a 403
  create-refusal falls back through `follow()`'s redirect-or-same-path GET to a plain 200 on
  `/Ad`, which passed regardless). `User.form.fill: { "role": "advertiser" }` now really is
  there, and the ad-placement check now asserts the POST itself is a 303 create and that the
  ad shows up, not just that some page loads.
- **Login (cases 2, 7).** Bands and advertisers share one `/login` page (one login entity,
  as the format requires); there is no separate "band login" vs. "advertiser login" URL.

## Misses

- `node kind` — no audio player and no inline YouTube embed; `audioUrl`/`youtubeUrl` render
  as plain text on the profile page, not a playable widget the visitor stays on-site for.
- `node kind` — no way to change a user's role after creation through the UI. Round 5's
  `byRole` looked like the fix (give `admin` a field list that includes `role`, keep the
  visitor-facing default list without it) — it is not: `runtime/render/form.mjs`'s `formView`
  computes `skip` from `Object.keys(ov.fill || {})` **unconditionally**, in both `'new'` and
  `'edit'` mode, so a field named as a `fill` key (here, `role`, needed to pin advertiser
  sign-ups) is hidden from *every* rendered form regardless of which role's `byRole.fields`
  would otherwise show it — confirmed directly: adding `byRole.admin.fields` with `"role"`
  still rendered no `<select name="role">` on `/User/:id/edit`. `fill` only ever *acts* on
  create (`routes/entity.mjs`'s `editRoute` never reads it), so this is a real, narrow gap in
  `formView`'s rendering, not a deliberate rule — worth a line in `docs/FORMAT.md` or a
  `mode === 'new'` guard on that `skip`, not chased here (it is a `runtime/render/form.mjs`
  change, one call site, but outside this round's named feature list, and this app has no
  other cheap way to demonstrate the fix independently). Only the seed data or direct `db`
  access can still promote a user.
- `composition` — no self-service profile edit for bands or advertisers after registration
  (see Weakened cases); management of an existing band's profile is admin-only (`admin: "*"`).

## New for this app

- Two different self-service "registration" mechanisms on the *same* login entity in one
  app: the built-in `roles.register` path (`/register`, fixed role "band") and a plain
  entity-create form left open to `guest` with `fill` forcing a different fixed role
  (`/User/new`, role "advertiser") — the second path is not documented as a signup mechanism
  in FORMAT.md but follows directly from composing `can.guest.User: ["create"]` with
  `User.form.fill`.
- Per-role `own` scoping applied to a *plain* (non-login) entity that references the login
  entity (`Ad.advertiser`), alongside a completely different, unscoped permission for another
  role (`band`) on an unrelated entity — confirms `own` is scoped per (role, entity) pair,
  not global.
