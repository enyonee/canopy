# linktree — webgen-bench/000073

## Weakened cases
- **Case 4 (copy the shareable link to the clipboard).** The stand is server-rendered
  HTML with no client-side JavaScript, so there is no clipboard API to drive. The
  check instead verifies the real substitute: the tree's public URL (`/Link`) is
  named on the home page and is directly reachable by a signed-out guest — a real,
  followable link rather than a simulated "copy" event.

## Misses
- `connector`/`block` — no clipboard/share-sheet primitive exists in the catalog
  (nothing writes to a client clipboard; the runtime renders HTML only, per
  README.md's "Фронт — вне обещания").
- `field kind` — no URL-shaped field kind that validates a real URL; `Link.url` is
  plain `text!`, so a non-URL string would be accepted (only presence is enforced).

## New for this app
- A single un-related entity (`Link`) as the whole product: no roles, no identity —
  full open CRUD is the "link tree dashboard" itself, and its own list page doubles
  as the public, shareable page (no separate "public view" node exists to fork the
  same data into an owner view and a visitor view).
- A `pages` entry used purely to name another route's address in prose (`/Link` as
  the shareable link) — the closest honest way to express "here is your public URL"
  without a real link-shortener or slug field.
