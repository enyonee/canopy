# shipnews — webgen-bench/000064

## Weakened cases

- Boolean fields submitted through an HTML form treat an absent value as `false` (the normal
  unchecked-checkbox convention), so placing an ad through the check sends `active: 'on'`
  explicitly rather than relying on the schema default of `true`.

## Misses

- `node kind` — no rich-media rendering for ad creative beyond the existing `image` field
  kind; a click-through counter or impression tracking is not expressible.

## New for this app

- Round 5's `pages[].sections` closes "the designated ad space on the website" case 6's own
  Weakened Case and the "no way to place a live query result inside a static page" Miss: the
  homepage now embeds `{ "list": "homeAds", "limit": 3 }` (a new, nav-hidden saved list, the same
  `where: { "active": 1 }` filter the public `/Ad` page already used), so there is now a literal
  ad space on the homepage itself, not only a separate page a visitor has to find — placing an ad
  through the admin backend makes it appear in both places in the same request.
- A single-role app (`admin` is the only signed-in role) with `anonymous: "guest"` and no
  `register`, so the backend is admin-only while every read-only section stays public.
- A form whose successful-create redirect (`after`) intentionally does not point back at the
  entity's own list, because the submitting role (`guest`) has no `view` permission on that
  entity (`Subscriber`) — landing there would 303 straight into `/login`. `after: "/page/home"`
  keeps the flash message reachable by the same visitor who triggered it.
