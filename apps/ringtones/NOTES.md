# ringtones — webgen-bench/000095

## Weakened cases

- **Case 2 (download initiates immediately, confirmation message).** A single action step
  cannot both write a record and stream a file response (`db.createRow` runs inside the
  transaction; the byte stream is a separate, unrelated route, `/file/Entity/:id/<field>`).
  "Download" is therefore a row action that records a `Download` row and confirms with a flash on
  the same page; the actual file bytes are the `file` field's own rendered link next to it, not a
  single click. Seeded `Content` rows have no attached file bytes (the seed format has no way to
  give a `file` field real content — confirmed empirically: a zero-byte upload is silently
  dropped by `runtime/server.mjs`'s multipart handler, `if (!v.size) continue;`); a real file only
  exists once an admin uploads one to a row, exactly like the reference `realty`/`medjournal`
  checks do it.

## Misses

- `block` — no block can create a record and serve a byte stream in one user action (see
  Weakened case 2).
- `composition` — a `Collection` "add without downloading" and a `Download` "record of downloading"
  are two different entities rather than one row with a status, because a `Download` row's
  existence *is* the download event (its `downloadedAt` is meaningful history), while a
  `Collection` row is a standing bookmark a member may remove — conflating them would make
  "remove from collection" also erase download history.

## New for this app

- Two `own`-scoped sibling entities from the same actions (`Download`, `Collection`), each fed by
  a different action on the same parent entity (`Content`) — `download` uses `db.createRow` (one
  row per download, a real history), `addToCollection` uses `db.ensure` (idempotent: adding the
  same item twice does not duplicate the bookmark).
- A `file` field left out of the create/edit form entirely (`Content.form` is never reached by any
  role — only `admin`'s catch-all `"*"` can edit) but still rendered in `Content.detail.fields`,
  demonstrating the field kind without ever exposing an upload control to members.
