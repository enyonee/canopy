# clinic — webgen-bench/000015

## Weakened cases

- **Case 3 (Contact Us page "includes a form").** The format has no way to embed a create
  form inside a list page or a static `pages` entry (a list page renders a table plus an
  "Add" link; the form itself is always a separate `/Entity/new` step — see
  `runtime/render.mjs` `listView`/`formView`). "Contact Us" is the `ContactMessage` list
  (office address, phone and email as its intro text) with a prominent link to the real
  form, checked as: open Contact Us, confirm the office details, follow the link, confirm
  the form fields. One extra hop versus the literal wording, not a missing feature.
- Cases 1, 2, 4 checked as specified.

## Misses

- `composition` — no way to render dynamic entity rows (e.g. a `TeamMember` catalogue)
  inside a static `pages` body; About Us names the team in prose instead, since the case
  only checks content accuracy, not an interactive team directory.

## New for this app

- The simplest content-only shape in this batch: two entities (a read-only catalogue, a
  create-only message log), no roles, no states, no connectors — everything else is two
  `pages` entries with cross-links (`links`) doing the "basic pages + simple navigation"
  the task asks for.
