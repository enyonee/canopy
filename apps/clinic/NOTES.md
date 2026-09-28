# clinic — webgen-bench/000015

## Weakened cases

- Cases 1, 2, 3, 4 checked as specified (case 3's old "one extra hop" workaround is gone —
  see New for this app).

## Misses

_None left specific to this app — both Misses/Weakened-case workarounds it used to record are
closed, see New for this app._

## New for this app

- Round 5's `pages[].sections` closes two things this app used to work around:
  - `{ "form": "ContactMessage" }` on a new static `contact` page embeds the *real* create
    form directly (posting to the normal `POST /ContactMessage` route) — Contact Us is now
    genuinely "a page that includes a form", not a list page with a prominent link one hop
    away. The old `ContactMessage.list` (office details as intro text) is now a hidden
    "Past messages" log, still the `after` target once a message is sent.
  - `{ "list": "team" }` on the About Us page embeds a real `TeamMember` catalogue (name,
    role, bio) — closing the "no way to render dynamic entity rows inside a static page"
    Miss this app used to record; the team is now data (browsable, in principle editable),
    not prose naming three people.
- The simplest content-only shape in this batch: three entities (two read-only catalogues, a
  create-only message log), no roles, no states, no connectors — everything else is three
  `pages` entries with cross-links (`links`) and embedded `sections` doing the "basic pages +
  simple navigation" the task asks for, now with two of those pages carrying real data/forms
  instead of only prose.
