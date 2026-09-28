# Contributing to Canopy

Pull requests are welcome. Keep them focused, understand the work you submit, and be ready to
explain and maintain it. Coding agents: read [AGENTS.md](AGENTS.md) first.

## Before you start

### Small changes

Bug fixes, new or better checks for an app, documentation, and narrowly scoped runtime fixes
can go straight to a pull request.

### Major changes

Open an issue and **discuss it before writing the implementation** for any of these:
- a change to the format (a new node kind, new semantics of an existing node);
- a new runtime dependency;
- a new layer or module boundary in `runtime/`;
- a new connector or transport;
- anything on the [roadmap](README.md#roadmap).

Prior discussion does not guarantee a merge, but a large pull request without it is likely to
be closed.

### Do not open an issue for work you are about to submit

If you are already implementing the change, link the pull request instead of opening an issue
for the same work. Open issues to report a problem or propose work you are not doing yourself.

## AI-assisted contributions

This project is largely written by coding agents, and they are welcome as tools, not as
unattended contributors. Do not give an agent a vague goal and submit whatever it produces.

Before opening a pull request, you must:

- keep the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behaviour;
- run the gates and exercise the changed behaviour yourself;
- open the pull request yourself after that review, not let an agent publish it on its own.

You are responsible for the code, whoever or whatever generated it.

## Pull request requirements

Every pull request body **must include at least one sentence written by you, in your own
words**, explaining what changed and why. A generated summary, a pasted transcript or a
checklist alone does not count.

You **must verify that the change works**. Passing gates are expected but are not proof:

- **bug fix**: reproduce the bug, then show that the same reproduction no longer fails;
- **runtime feature**: add or extend an app, or a check, that uses it end to end;
- **app change**: run its checks, open the app, and use the changed path;
- **performance change**: numbers before and after on the same data, and the benchmark routes'
  JSON answers byte-identical.

Gates for any change under `runtime/`, `verify/` or `tests/`:

```bash
npm run gate          # tests, architecture gates, 100 % line coverage, types, mutations
node verify/run.mjs   # every app's acceptance checks
```

CI runs the tests, coverage, types and all acceptance checks on every pull request. The
mutation gate runs weekly.

Keep each pull request to one logical change: no drive-by refactors, generated noise or
features outside the agreed scope. Update `CHANGELOG.md` under *Unreleased* for anything
user-visible.

## Versions and releases

Canopy is pre-1.0. Versions follow the roadmap, not the calendar:

- **0.x** (a minor bump, e.g. 0.1 → 0.2) when a roadmap item moves: a milestone of Postgres,
  horizontal scaling, the connector library, or a new format capability.
- **0.x.y** (a patch bump, e.g. 0.1.0 → 0.1.1) for work that completes or refines the current
  goal without advancing the roadmap: optimizations, fixes, better checks, docs.

Every release has a tag `vX.Y.Z` on `main`, a GitHub release, and a `CHANGELOG.md` section.
Performance releases include the before/after table.

## Contribution licensing

A contribution intentionally submitted for inclusion in Canopy is licensed under the
[MIT License](LICENSE). You must have the right to submit it, and you must keep any
third-party copyright and license notices. No CLA or DCO is required.

## Review

Maintainers review the submitted behaviour and your understanding of it, not the volume of
generated code. Respond to review feedback yourself, and only apply suggestions you have
checked. Pull requests may be closed when they skip a required discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated changes.
