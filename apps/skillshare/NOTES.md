# skillshare — webgen-bench/000092

## Weakened cases

- **Case 2 ("search for a user based on a specific skill").** The search is over the `Skill`
  entity itself (name + level + owner columns), not a join/full-text search across `User`
  through its skills — the format has no cross-entity list search. Finding "who has skill X"
  means reading the `owner` column of the matching `Skill` rows, which is exactly what the
  check does and is a normal, honest way to browse the result.

## Misses

- `composition`: no fielded search across a relation ("find users where any of their skills
  matches X") — only a direct entity's own stored text fields are searchable. Recorded rather
  than faked with, say, a derived text field concatenating all of a user's skill names (which
  would need a `count`/`sum`-shaped aggregate, not a string one — the algebra has no string
  aggregate).
- `composition`: a `related` section's inline add-form always attributes the new child row to
  the **page's own row** (via the `via` field), not to the signed-in viewer — so it cannot be
  used for "add your own skill" on a profile someone else might be viewing. Skill/Certification
  creation is therefore a separate top-level form with `fill: {owner: "@me"}` (always
  session-authoritative — confirmed in `runtime/server.mjs`: `fill` is spread after the
  submitted values, so it silently overrides anything a client sends for that field), and the
  profile page only ever *displays* them (`"form": false` in the `related` block).
## New for this app

- `after: "/Entity/{field}"` where `{field}` is a field of the **row the form just created**
  (`Skill.owner`), not the current session or a literal id — used to land the user back on
  their own profile page after adding a skill/certification from a detached top-level form.
- Round 4: `own` grew `all`, so `Skill`/`Certification` moved off the `fill`-only workaround
  onto `{"own": "owner", "can": ["edit", "delete"], "all": ["view", "create"]}` — still fully,
  publicly browsable and self-attributed on creation (`own`'s auto-fill replaced the form's
  `fill: {"owner": "@me"}`), but a member can now edit or delete their own entries too, which a
  plain unscoped grant never allowed. Closes the "no protection against duplicate skill
  entries" Miss too: `rules.Skill: [{"unique": ["owner", "name"], ...}]` (compound uniqueness,
  also new this round) stops a member listing "Python" twice, without stopping two different
  members from both listing it.
