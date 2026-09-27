# cv — webgen-bench/000072

## Weakened cases
- None. All five sections and the cross-section navigation are checked through their
  real routes; the education/experience "logical order" is asserted as most-recent-first
  by `startDate`, since the instruction does not fix a specific ordering.

## Misses
- `composition` — "Skills…emphasizing proficiency levels if applicable" has no bar/dot
  meter kind; `level` is a plain enum column (matches REPORT.md's noted absence of a
  chart/graphic node in the catalog).
- `field kind` — no rich-text or bullet-list field for job "responsibilities or
  achievements"; `Job.description` is `longtext`, rendered as one block of text.

## New for this app
- Five sibling entities (Profile, Job, Skill, Education, Project) with no relations
  between them at all — the CV's sections don't reference each other, so this is the
  simplest possible instance of the brief's "keep content as data" instruction: each
  section is independently browsable, searchable (via list filters) and editable
  (create/edit/delete) instead of being baked into static `pages` prose.
- No `roles`/`identity`: a single owner's CV, fully open, like `apps/realty` and
  `apps/prices` — the closest fit for "personal site with manageable content" when the
  task names no second user or login flow at all.
