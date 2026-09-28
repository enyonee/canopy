# obituaries — webgen-bench/000067

## Weakened cases

- **Case 3 (leave a condolence).** Condolences are a free-text `authorName`, not an account
  reference — anyone, including a signed-out guest, can leave one, matching "users should be
  able to ... leave messages" without requiring registration for that specific action.

## New for this app

- A `dashboards` node with `period` (date-range narrowing on `Obituary.createdAt`) and a
  `groupUnit: "month"` table alongside plain `count` cards — the "statistical analysis"
  case is a real grouped aggregate, not a hand-written report.
- An `image` field used purely for display (uploaded once at publish time, shown as a
  thumbnail on the detail page), with no edit path afterwards.
- Round 4: `own` grew `all` (unscoped operations alongside owned ones — see README/FORMAT.md).
  **"Manage their own obituaries" no longer needs a weakened case:** `member.Obituary` is now
  `{"own": "owner", "can": ["edit", "delete"], "all": ["view", "create"]}` — everyone still
  browses and reads every obituary to leave condolences (`view`/`create` unscoped), but a
  member may now edit or delete only the one they published; the `owner` fill moved from the
  form's `fill` to `own`'s own auto-fill (the same field, one less place declaring it). Both
  `Obituary.list` and `/list/my-obituaries` gained `edit`/`delete` row actions, shown only on
  rows the viewer actually owns (the admin still sees them on every row).
