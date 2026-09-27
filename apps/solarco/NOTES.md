# solarco — webgen-bench/000016

## Weakened cases

- **Case 2 (product detail "including... images").** `image`/`file` fields store an upload's
  filename and render `<img src="/file/Entity/:id/field">`; the seed step only writes field
  values, it does not place a matching file under `files/` (see `runtime/fields.mjs:93-96`,
  `runtime/store.mjs` seeding), so a seeded `image` field would 404. `photo` is a plain `text`
  caption ("photo: matte-black panel, low-profile aluminium frame") standing in for the
  picture; the check asserts the caption is shown, not a real `<img>`.
- Cases 1, 3, 4, 5 checked as specified.

## Misses

- `field kind` — no seedable image: an `image` field only works once a real file exists
  (uploaded through the multipart form), so it cannot back a "comes with product photos
  out of the box" catalogue.

## New for this app

- `NewsItem.list` sorted `desc` by a `date` field as the whole "newest first" requirement,
  no extra plumbing needed.
- A single home page (`page/company`) doubling as one of the four required nav destinations
  (Company Introduction *is* the homepage, not a fifth page) — `home` points straight at it.
