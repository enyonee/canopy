# designfolio — webgen-bench/000071

## Weakened cases
- None. Every case is driven through real routes: the Portfolio and About nav links
  are read from the rendered `<nav>`, the contact form is a real `POST /Message`
  (rejected with 400 when incomplete, confirmed with a flash when valid).

## Misses
- `field kind` — `Work.image` is declared as a real `image` field (multipart upload,
  a genuine thumbnail once set), but seed data leaves it blank: seeding a filename
  string with no backing file would render a broken/fake thumbnail link, which the
  brief forbids. A designer would attach images through the edit form after launch.
- `composition` — there is no way to keep `Profile` a true singleton (always exactly
  one row); it is one seeded row with `create: false` on its list, which is close but
  not an enforced invariant.

## New for this app
- A no-`roles`, no-`identity` app: everything is open, matching the brief's "keep
  content as data (works, jobs, skills, projects, links) so it can be browsed,
  searched and managed" — the whole site (portfolio works, the about profile, and
  contact messages) is plain CRUD data rather than static `pages` text, so an owner
  can edit their own bio/experience/contact info through the derived form instead of
  the graph being redeployed.
- A public `Message.form` (no `fill`, no login) as the closest honest rendering of a
  "contact form": anyone can create a `Message` row; required fields (`name!`,
  `email!`, `body!`) give the validation-error path for free.
