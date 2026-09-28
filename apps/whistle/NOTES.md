# whistle — webgen-bench/000032

## Weakened cases

- **Case 1 (anonymous reporting).** "Insights and evidence" is `title` + `details` + an
  optional `evidence` file; there is no author field anywhere on `Report`, no session, no
  identity node at all in the app, so nothing links a report back to a visitor.
- **Case 2 (discussion forum).** Threads and replies carry a free-text `authorName` (default
  `"Anonymous"`) instead of an account — there is no login on this site at all, matching the
  anonymity the instruction asks for everywhere, not just on reports.
- **Case 5 (navigation menu).** "Search" is not its own nav link — it is the header search box
  every page now offers (round 5's top-level `search` node), not a fifth `pages[].links` entry;
  the check verifies the four nav labels, that every nav link resolves, and separately (case 3)
  that the header search box is present and the unified `/search?q=` page actually works.

## Misses

_None left specific to this app — both Misses it used to record are closed, see New for this app._

## New for this app

- Round 5's top-level `search: { "entities": ["Report", "Thread", "Article"], "title": "Search" }`
  closes the "no unified cross-entity search" Miss: `/search?q=` renders one section per entity
  (each still matched against that entity's own `Entity.list`'s own `search` fields, titled with
  that list's own title — "Anonymous Reporting", "Forum", "News & Blog"), and a search box now
  appears in the page header on every page, for every viewer, resolving "Search" as a real,
  reachable feature rather than three separate list search boxes a visitor has to already know
  about.
- Round 5's `pages[].sections` closes the "a static page cannot embed a live query result" Miss:
  the homepage now embeds a `{ "list": "latestReports", "limit": 3 }` section (a new, nav-hidden
  saved list sorted by `createdAt` descending) showing the 3 most recent reports inline, read with
  the viewer's own permissions like any other saved list — `checks.mjs`'s reporting case confirms
  a just-submitted report actually shows up there.
- A fully public app with neither `roles` nor `identity` — every entity is reachable by
  anyone, matching a site whose entire point is that visitors need not be known.
- A `file` field (`Report.evidence`) with no owning role/identity at all, still form-only
  (never rendered) except as the download link on the row it belongs to.
