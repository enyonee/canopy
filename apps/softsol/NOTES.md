# softsol — webgen-bench/000019

## Weakened cases

- **Case 2 ("the search functionality allows users to find relevant articles and product
  descriptions").** `search` is a property of one entity's list (`Entity.list.search` / a
  named `list`'s `search`), there is no cross-entity full-text search node. Solutions and
  Industry News each get their own search box instead of one unified one; the check searches
  each catalogue separately.
- Cases 1, 3, 4, 5 checked as specified.

## Misses

- `node kind` — no unified/cross-entity search index; every search box is scoped to one
  entity's stored text fields.

## New for this app

- Two independent `search` configurations reused for the same "search the site" requirement,
  with a `filters` block (Category) added on top of `search` for the Solutions catalogue -
  first app to combine both on one list.
