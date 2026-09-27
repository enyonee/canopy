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

- `composition`: `own` applies uniformly to every operation (`view`, `edit`, `delete`, `go`,
  `do:*`) for a given role+entity pair (confirmed by reading `runtime/auth.mjs`'s single
  `entitySpec(role, entity)`), so "everyone can view, only the owner can edit" is not
  expressible on one entity for one role. A real profile-edit feature would need either (a) a
  second, `own`-scoped entity holding only the editable fields (as `apps/fooddist` does for
  contact details, at the cost of the row no longer being the same one search filters over), or
  (b) an admin-only edit path. Neither was needed here since no case tests self-edit, but it
  would recur the moment one did.
- `composition`: a saved `lists[]` entry ANDs its own fixed `where` with the acting role's
  `ownWhere` (confirmed in `runtime/server.mjs`'s list route) — so a role that owns an entity by
  field A cannot get a *second*, differently-scoped view of the same entity via a list with a
  fixed `where` on field B; the list's own filter would be silently intersected with the wrong
  ownership condition and return nothing. This is why per-user message privacy here uses `own`
  directly on the entity (one field, `to`) rather than two saved lists — the two-list approach
  (tried first while designing this batch) breaks exactly this way.
- `rule`: no rate limiting or anti-spam on `contact` — any member can message any other member
  any number of times; not exercised by any check.

## New for this app

- Proved that a single `own` field on the *entity itself* (not a saved list) genuinely gives
  two members of the *same* role private, symmetric messaging with no extra plumbing: member
  role owns `Message` via `to` (`can: ["view"]`, no `create`), and the row is always created by
  an action on the *other* user's row (`in: "User"`, `do:contact`) — the sender never needs
  "own" or "create" permission on `Message` at all, only the `do:contact` operation on `User`.
  Verified live that a third member's `/Message` is empty and a direct `/Message/:id` for
  someone else's row 403s.
- A rule expression combined with a plain default (`age >= 18` alongside `age=25` as the
  field's own default) — the first rule check in this batch that rejects on a computed
  condition over a freshly-filled registration field rather than a referenced/derived one.
- `guest: {}` — an explicitly empty permission set for the anonymous role (rather than omitting
  the role or naming entities with no ops), fully gating a site behind login while keeping
  self-registration open.
