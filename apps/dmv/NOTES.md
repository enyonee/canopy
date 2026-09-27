# dmv — webgen-bench/000062

## Weakened cases

- **Case 1 (question bank accessibility).** Read as "loads without error for anyone",
  including a guest; there is no accessibility-tooling integration (see Misses).
- **Case 3/5 (simulated exam, score display).** One exam always covers the whole
  bank (5 questions); there is no timed or partial exam. The score is a derived
  percentage (`round(100 * correct / answered)`), shown on the exam's own detail
  page — there is no separate "results screen".
- **Case 6 (navigation "seamless … no dead ends").** Checked as every top-level
  menu item returning 200 for a signed-in student; the answer sub-form staying
  visible after submission (Misses) is not a broken link.

## Misses

- `composition` — the inline "Answers" add-form on `Exam.detail` still renders
  after the exam is submitted (a submitted exam's `Answer` rule already refuses a
  further POST, so nothing wrong happens, but the button stays); no per-status
  hiding of a `related` form exists in the format.
- `node kind` — no accessibility-audit tool integration (case 4 of the original
  task, "online accessibility checker"); out of scope for a closed graph.

## New for this app

- Grading on write: `events: Answer.created` runs `check.matchRef` against the
  question's own answer field, so a wrong choice is known the instant it is saved,
  not recomputed on read.
- A derived score with a guarded division: `coalesce(round(100 * count(correct) /
  count(answered), 0), 0)` — division by zero (no answers yet) reads as 0, not null.
- Two saved lists scoped to `@me` with different intents: `my-practice` (things
  picked, deletable) and `my-errors` (a read-only report over `Answer`, `where:
  {student: "@me", correct: 0}`).
- A rule that hops through a reference to check state twice: `Answer` refuses
  writing to an already-submitted exam (`exam.status != 'submitted'`) and refuses
  a duplicate answer to the same question in the same exam via a correlated count.
