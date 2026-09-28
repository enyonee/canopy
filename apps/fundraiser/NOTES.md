# fundraiser — webgen-bench/000017

## Weakened cases

- **"One-page site" (all cases, structurally).** The scaffold has no single-DOM-page
  composition — a `page` renders one static body plus one optional widget, and an entity's
  data lives at its own route. "One page" is delivered as a landing page (introduction copy +
  the carousel widget) linking to Testimonials / Offers / Company Information as their own
  routes, exactly the shape `apps/obituaries`, `apps/poetry` and `apps/linktree` already use
  for the same reason. The navigation case (case 4) tests exactly this: every section is one
  click from home and from the header, not scrolled to on one document.
- **Testimonials/offers/company info are curated, not user-submitted** (`create: false` on
  all three lists) — a promotional brochure's content is the organization's own, not a public
  form; nothing here fabricates a submission flow the instruction never asked for.

## Misses

- `block` — none needed. The only interactive piece (the carousel) neither writes storage
  nor referees a rule, so the plugin registers a widget and nothing else (same shape as
  apps/htmleditor's plugin).
- `composition` — a page widget has no per-row context (a page has no row), so the carousel
  widget fetches `/Offer` itself via `api.get` inside `mount()` rather than receiving the
  offers as a declared prop; the format's `props` are static per-node values, not a live
  query, so this is the only way a page widget can show rows that might change over time.

## New for this app

- The first widget in the repo that is a **page** widget (`pages[].widget`, no row) rather
  than an entity-detail widget — no `data-row`, and the widget supplies its own data through
  `api.get` at mount time instead of reading it off the server-rendered row.
- A widget whose only behaviour is a `setInterval` timer with no user input at all — the
  round-4 rule ("a widget renders state and sends intents") is satisfied in only one direction
  here: rendering state that changes on its own, sending no intents back to the server, since
  a promotional carousel has nothing to write.
