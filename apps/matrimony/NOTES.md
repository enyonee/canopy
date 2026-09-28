# matrimony — webgen-bench/000091

## Weakened cases

- **Case 1 ("create profiles, including uploading photos and filling out personal
  information").** No ui_instruct case tests a separate profile-edit screen, so the profile
  fields (age, gender, location, interests, bio, photo) live directly on `User` and are filled
  at registration. This sidesteps a real format limitation (see Misses): `own` scopes every
  operation on a role+entity pair together, so a single role cannot have public unscoped
  *viewing* of everyone's profile (needed for search) and privately scoped *editing* of just
  its own row at the same time. Splitting profile data onto `User` avoids needing self-edit at
  all, since it is never exercised by a check.
- **Case 4 ("in real-time").** Request/response only — each message is a normal POST, read on
  the next GET, not a live socket.

## Misses

- `composition`: `own` needs a `ref:<user entity>` field *on* the entity being scoped, and
  `User` (the login entity) has none pointing at itself — round 5's `own`+`all` split (see
  `apps/qna`/`apps/obituaries`) would let a role view everyone's profile unscoped while editing
  only its own row, *if* `own` could target `User` at all; it still cannot. A real profile-edit
  feature would need either (a) a second, `own`-scoped entity holding only the editable fields
  (as `apps/fooddist` does for contact details, at the cost of the row no longer being the same
  one search filters over), or (b) an admin-only edit path. Neither was needed here since no
  case tests self-edit, but it would recur the moment one did.
- `rule`: no rate limiting or anti-spam on `contact` — any member can message any other member
  any number of times; not exercised by any check.

## New for this app

- Proved that `own` on the *entity itself* (not a saved list) genuinely gives two members of
  the *same* role private, symmetric messaging with no extra plumbing: the row is always
  created by an action on the *other* user's row (`in: "User"`, `do:contact`) — the sender
  never needs "create" permission on `Message` at all, only the `do:contact` operation on
  `User`. Verified live that a third member's `/Message` is empty and a direct `/Message/:id`
  for someone else's row 403s.
- Round 5: `own` may now name several fields (a role owns a row if *any* one of them matches).
  `member.Message` moved from `own: "to"` (only the recipient could ever see a conversation
  through `/Message` — the previous workaround, and the reason per-user privacy here used one
  `own` field rather than two saved lists with a fixed `where`, since a list's own `where` and
  the role's `ownWhere` always AND together, never OR) to `own: ["to", "from"]`: the sender now
  sees their own sent messages there too, symmetrically, with no second list and no change to
  `do:contact` at all.
- A rule expression combined with a plain default (`age >= 18` alongside `age=25` as the
  field's own default) — the first rule check in this batch that rejects on a computed
  condition over a freshly-filled registration field rather than a referenced/derived one.
- `guest: {}` — an explicitly empty permission set for the anonymous role (rather than omitting
  the role or naming entities with no ops), fully gating a site behind login while keeping
  self-registration open.
