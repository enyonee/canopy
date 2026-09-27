# biography — webgen-bench/000074

## Weakened cases
- **Case 4 / 5 (a "Search" section reachable from the nav).** The format has no
  cross-entity search node — `search` is a property of one entity's list, matching
  only that entity's stored text fields. There is no unified "Search" page: search is
  the query box already on the Achievements (and Life Experiences) list. The check
  drives search through `/Achievement?q=…` directly rather than clicking a dedicated
  "Search" nav item, since none can exist without inventing a fake one.

## Misses
- `node kind` — a unified, cross-entity search (one box that can surface a hit from
  either Life Experiences or Achievements) does not exist; each list searches only
  its own stored text fields. Confirmed absent from the catalog in REPORT.md's miss
  summary (no site-wide search block across the round-2/3 apps either).
- `composition` — no dedicated "timeline" rendering; `LifeExperience.list` sorted by
  `date` ascending is the closest honest stand-in for a visual timeline.

## New for this app
- `Person` as a true one-row entity used as the literal homepage (`home: "/Person"`,
  `Person.list` titled "Home", `create: false`): the homepage's basic facts (name,
  birthdate, summary) are real, editable data rather than fixed `pages` prose, per
  the brief's "keep content as data … browsed, searched and managed".
- Two independent, unrelated timelines (`LifeExperience`, `Achievement`) each sorted
  by their own `date` field in opposite directions (earliest-first for the life
  story, most-recent-first for achievements) — the first app in this batch with two
  different default sort directions across sibling entities.
