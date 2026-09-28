## What

<!-- At least one sentence in your own words: what changed and why (CONTRIBUTING.md). -->

## Why

<!-- Motivation, context, or the issue this closes (fixes #N). Major changes need a prior discussion. -->

## Verification

<!-- The exact scenario you exercised and what happened. For a bug: the reproduction before and after.
     For performance: numbers before and after on the same data, and whether the JSON answers stayed identical. -->

---

- [ ] `npm run gate` passes (tests, architecture gates, coverage, types, mutations), for runtime changes
- [ ] `node verify/run.mjs` passes
- [ ] I reviewed every changed file and exercised the changed behaviour myself
- [ ] `docs/FORMAT.md` updated, for format changes
- [ ] `CHANGELOG.md` updated under *Unreleased*, for user-visible changes
