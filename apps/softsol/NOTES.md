# softsol — webgen-bench/000019

## Weakened cases

- Cases 1, 2, 3, 4, 5 checked as specified (case 2's "one unified search box" workaround is
  gone — see New for this app).

## Misses

_None left specific to this app — the one Miss it used to record is closed, see New for this
app._

## New for this app

- Round 5's top-level `search: { "entities": ["Solution", "NewsArticle", "CustomerStory"] }`
  closes the "no unified/cross-entity search index" Miss: `/search?q=` now renders one section
  per entity (each still matched against that entity's own `Entity.list`'s own `search` fields)
  from one search box in the page header, on every page — a real "find relevant articles and
  product descriptions" in one place, not three separate per-catalogue boxes a visitor has to
  already know exist. `CustomerStory.list` picked up its own `search` (`client`/`title`/
  `summary`/`body`) as part of this, closing a small pre-existing gap of its own: it previously
  had no search box at all, on its own list or anywhere else.
- Two independent per-list `search` configurations kept alongside the new unified one (each
  catalogue's own search box still narrows just that list), with a `filters` block (Category)
  added on top of `search` for the Solutions catalogue - first app to combine both on one list.
