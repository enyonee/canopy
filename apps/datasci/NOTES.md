# datasci — webgen-bench/000056

## Weakened cases

- **Case 4 (module content).** "Text, images, and videos, if applicable" is a `longtext` content
  field (text), an `image` field (`diagram`, unset on the seeded module — not exercised because
  the seed data doesn't need one) and a `videoUrl` plain `text` field holding a link, not an
  embedded player: the format has no video field kind, and a URL is the honest substitute.
- **Case 5/6 ("Submissions" / grades).** There is no single course-wide "Submissions" page:
  a submission is reflected immediately under its assignment (`Assignment.detail`'s related
  table) and in the student's own `My Submissions` list (`/Submission`, own-scoped), which is
  also where case 6's grades are queried — one entity list serves both, filtered per role instead
  of being two separate features.
- **Grading itself** isn't a `ui_instruct` case, so it has no dedicated UI: the admin grades by
  editing the submission's `score`/`feedback` fields directly (`Submission.form` restricts the
  edit form to just those two fields). The check does this over HTTP to set up case 6's data,
  the same way a real admin would through the (unstyled) edit form.

## Misses

- `composition` — access to a course's modules/assignments cannot be conditioned on the viewer
  having an `Enrollment` row for that course: `own` scopes a role to rows that directly reference
  the session user, not to rows reachable through a join table. Any signed-in student (or even a
  guest, per their `Module`/`Assignment` `view` grant) can open `/Module/:id` without enrolling —
  the same "conditional right" gap `README.md` already names for order lines after checkout.
- `field kind` — no video field; `videoUrl` is plain `text`.

## New for this app

- A derived field computed from **one hop through a reference on a nullable base field**:
  `percent := round(score * 100 / assignment.maxScore, 0)`, null-safe end to end (null score →
  null product → null quotient → `round(null)` → null) with no branching needed in the
  expression.
- A rule that hops through a reference to bound a field by another entity's value:
  `score >= 0 and score <= assignment.maxScore`.
- The same own-scoped entity list serving two different roles under two different names in the
  user's head ("My Courses" / "all enrollments", "My Submissions" / "grade queue") through a
  single `Entity.list` override — no saved `lists[]` entry needed once `own` does the filtering.
