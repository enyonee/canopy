# teamshow — webgen-bench/000075

## Weakened cases
- **Case 2 ("images, or other media").** `Project.image` is a real `image` field but
  is left blank in seed (no backing file to upload) — the description and link carry
  the "detailed view" instead. See Misses.

## Misses
- `field kind` — `Project.image` declares real upload capability but seed data can't
  attach a genuine file without faking one (same reasoning as designfolio/NOTES.md);
  a team member would attach project photos through the edit form after launch.
- `composition` — the "Contact" page unavoidably doubles as the message log: the
  format ties a create form to its entity's list (`/Message` shows both the intro
  with the team's email/phone and every past message plus the "Send a message"
  button); there's no way to keep a page that is *only* a submission form with the
  entity still reachable from the nav (hiding it removes the nav link entirely).

## New for this app
- Four independent entities with no relations between them (Member, Project, Skill,
  Message) — team, portfolio, skills and contact form are all separate data, each
  browsable/searchable/editable on its own, per the brief.
- `rules: { "Skill": [{ "unique": "name" }] }` used purely to keep the "no redundancy"
  requirement of case 3 honest at the data layer, not just by seeding carefully.
