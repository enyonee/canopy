# whistle — webgen-bench/000032

## Weakened cases

- **Case 1 (anonymous reporting).** "Insights and evidence" is `title` + `details` + an
  optional `evidence` file; there is no author field anywhere on `Report`, no session, no
  identity node at all in the app, so nothing links a report back to a visitor.
- **Case 2 (discussion forum).** Threads and replies carry a free-text `authorName` (default
  `"Anonymous"`) instead of an account — there is no login on this site at all, matching the
  anonymity the instruction asks for everywhere, not just on reports.
- **Case 3 (search across topics and keywords).** "Across all sections" is three separate
  search boxes (`Report`, `Thread`, `Article` lists each have their own `search:` fields), not
  one unified query; the check hits all three lists and asserts each returns matches.
- **Case 5 (navigation menu).** "Search" is not its own nav destination — there is no
  standalone search node in the format, only a `search:` list property. The nav instead
  shows Home, Anonymous Reporting, Forum and News & Blog; the check verifies those four
  labels and that every nav link resolves, and documents that "Search" is the search box on
  the Forum/News/Reports lists rather than a fifth page.

## Misses

- `node kind` — no unified cross-entity search: each list's `search:` only matches its own
  entity, so "search across all sections" is three lists, not one query.
- `composition` — a static `page` cannot embed a live query result (e.g. showing the 3 latest
  reports on the homepage); the homepage only links out to the three lists.

## New for this app

- A fully public app with neither `roles` nor `identity` — every entity is reachable by
  anyone, matching a site whose entire point is that visitors need not be known.
- A `file` field (`Report.evidence`) with no owning role/identity at all, still form-only
  (never rendered) except as the download link on the row it belongs to.
