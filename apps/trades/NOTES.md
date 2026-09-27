# trades — webgen-bench/000052

## Weakened cases

- **Case 1 (update profile).** "Name" and "email address" live on the `User`
  row, not the profile; the profile a worker edits (`headline`, `phone`,
  `skills`, `qualifications`, `photo`, …) is the owned `Profile` row, matching
  the task's own field list minus the two identity fields a form cannot split
  by role safely (see the same reasoning in `medjournal`/`fooddist`).
- **Case 4 (navigation "home, profiles, job postings").** A guest's home redirects
  straight to job listings (guests may not view `Profile`, only `Job`); "profiles"
  is checked signed in as an employer, who can see the Workers list.

## Misses

- `node kind` — no messaging between worker and employer beyond the application
  message and the mail sent on hire; no resume/CV file, only a profile photo.
- `composition` — an application's `employer` is filled from the job at apply
  time (`@row.employer`), so a job that changes employer after an application
  exists would strand the old value; not reachable from the UI (`Job.employer`
  is never edited after creation in this app).

## New for this app

- An event creates a sibling row: `User.created` → `db.createRow Profile {user:
  @row.id}`, so every self-registered worker gets an empty profile to fill in,
  while `Application.employer` is copied from the job at apply time so an
  employer's own-scoped list needs no join through `Job`.
- Two `own` roles on the same `Application` entity from opposite sides:
  `worker: {own: "worker"}` (view only) and `employer: {own: "employer"}` (view
  and the three transitions) — one row, two disjoint owners.
- A derived count with an explicit correlation because the child has no direct
  reference to the parent: `Profile.applications := count(Application: worker =
  row.user)`.
