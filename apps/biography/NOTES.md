# biography — webgen-bench/000074

## Weakened cases
- **Case 4 / 5 ("Search" reachable from the nav).** "Search" is the header search box
  every page now offers (round 5's top-level `search` node), not a `pages[].links` nav
  entry — there being no `pages` at all in this app (the homepage is `Person.list`
  itself), a dedicated "Search" page would have meant inventing a page node purely to
  hold a link; the header box is the real, already-documented mechanism instead.

## Misses
- `composition` — no dedicated "timeline" rendering; `LifeExperience.list` sorted by
  `date` ascending is the closest honest stand-in for a visual timeline.

## New for this app
- Round 5's top-level `search: { "entities": ["LifeExperience", "Achievement"] }` closes
  the "no unified, cross-entity search" Miss this app used to record (and REPORT.md's own
  miss summary): `/search?q=` now renders one section per entity, from one search box in
  the page header on every page — a real, reachable "Search" affordance, not only the two
  per-list query boxes a visitor has to already know exist. `checks.mjs` confirms a term
  that only appears in `LifeExperience` ("Turin") surfaces there and nowhere else.
- `Person` as a true one-row entity used as the literal homepage (`home: "/Person"`,
  `Person.list` titled "Home", `create: false`): the homepage's basic facts (name,
  birthdate, summary) are real, editable data rather than fixed `pages` prose, per
  the brief's "keep content as data … browsed, searched and managed".
- Two independent, unrelated timelines (`LifeExperience`, `Achievement`) each sorted
  by their own `date` field in opposite directions (earliest-first for the life
  story, most-recent-first for achievements) — the first app in this batch with two
  different default sort directions across sibling entities.
