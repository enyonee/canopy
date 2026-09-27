# shipnews — webgen-bench/000064

## Weakened cases

- **Case 6 (ad space management).** "The designated ad space on the website" is the public
  `/Ad` list (an entity list filtered to `active`), not a banner embedded inside another
  page — the format has no way to embed dynamic rows inside a static `page` body, so there
  is no literal "ad space" on the homepage itself; the closest honest reading is a dedicated,
  publicly visible Ads page that only the admin can add to.
- Boolean fields submitted through an HTML form treat an absent value as `false` (the normal
  unchecked-checkbox convention), so placing an ad through the check sends `active: 'on'`
  explicitly rather than relying on the schema default of `true`.

## Misses

- `composition` — no way to place a live query result (an ad banner, a "latest 3 articles"
  widget) inside a static page's body; `pages[].body` is fixed paragraphs only.
- `node kind` — no rich-media rendering for ad creative beyond the existing `image` field
  kind; a click-through counter or impression tracking is not expressible.

## New for this app

- A single-role app (`admin` is the only signed-in role) with `anonymous: "guest"` and no
  `register`, so the backend is admin-only while every read-only section stays public.
- A form whose successful-create redirect (`after`) intentionally does not point back at the
  entity's own list, because the submitting role (`guest`) has no `view` permission on that
  entity (`Subscriber`) — landing there would 303 straight into `/login`. `after: "/page/home"`
  keeps the flash message reachable by the same visitor who triggered it.
