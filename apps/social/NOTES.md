# social — webgen-bench/000090

## Weakened cases

- **Case 2 ("redirected to their personal homepage, which welcomes them by name").** A static
  `page` cannot interpolate a signed-in user's field into its body text, so the personalised
  homepage is a saved list scoped to the login entity itself (`{"entity": "User", "where":
  {"id": "@me"}}`) — the only row it ever shows is the viewer's own, with their name as a real
  table cell.
- **Case 3 ("profile picture... and any recent updates").** There is no separate avatar field;
  the uploaded photo doubles as both gallery content and the "profile picture" the case asks
  for, shown via a `related` "My uploads" section on the user's own detail page. This is more
  honest than adding a cosmetic avatar field nothing else in the brief calls for.
- **Case 7 ("performing an action that earns points, e.g. logging in...").** Points are a
  derived aggregate (`count(Photo) * 10`), not a mutable balance, so they can only respond to
  actions that create a row of something the algebra can count — uploading, here. A login
  cannot award points: `events` only fires on `Entity.created/updated/deleted`, and signing in
  creates no row of anything (see Misses).

## Misses

- `node kind`: no login-triggered event — the format's session/auth layer is not an entity, so
  nothing in `events` can hook "user logged in". Any "points for logging in" reading of case 7
  is unavailable; the check exercises the upload path the brief's own example (b) offers
  instead.
- `composition`: a member cannot edit their own `User` row (name/email) because `own` requires
  a `ref:User` field *on* the entity being scoped, and `User` has none pointing at itself — the
  same gap noted in apps/sportsrecruit's NOTES. Only `admin` can edit a member's profile fields;
  not exercised by any check here.

## New for this app

- Round 5: closed the "nothing stops a member voting on the same photo twice" Miss, but not
  with `rules.unique` — a rule only ever runs inside `interp.validateValues`, which the HTTP
  create/edit routes call and a step's own block (`db.createRow`, here) never does (steps are
  trusted graph code; see `runtime/ARCHITECTURE.md`), so a compound-unique `Vote` rule would
  have been declared and silently never checked. `votePhoto`'s step is `db.ensure` instead of
  `db.createRow`: a repeat vote finds the existing `Vote` row instead of inserting a second one,
  so `Photo.votes := count(Vote)` never double-counts — idempotent by construction, not by a
  rule that cannot reach this path.
- The same "saved list scoped to the login entity's own row" idiom from apps/sportsrecruit,
  this time doubling as the actual `home` redirect target rather than a secondary nav item —
  confirmed live that the `?ok=` flash query string survives the `/` → `/list/me` home redirect,
  so the welcome message and the personalised row render on the same landing page.
- A `related` block with `"form": false` used purely to surface another entity's rows read-only
  under a detail page — no inline add form, no `rowActions`, just a second view of data that
  already has its own primary list (`Photo`) and creation path.
- A derived field that is a simple multiplier over a count (`count(Photo) * 10`) rather than a
  qualified/correlated aggregate — the plainest form of "points as a derived aggregate".
