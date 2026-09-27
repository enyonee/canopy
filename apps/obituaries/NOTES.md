# obituaries — webgen-bench/000067

## Weakened cases

- **"Manage their own obituaries" (instruction, no dedicated ui_instruct case).** Members can
  publish but not edit or delete obituaries — only the admin can. The format's `own` scoping
  restricts *every* listed operation (view included) to the owner's rows, and members must
  still browse and read each other's obituaries to leave condolences, so scoping edit/delete
  to the owner would also have hidden everyone else's obituaries from them. `apps/qna`
  documents the same trade-off ("members create-only and leave editing to the admin"); the
  "my obituaries" personal list (`/list/my-obituaries`) is the "manage" surface that remains —
  a personal view of what you published, not per-row edit rights.
- **Case 3 (leave a condolence).** Condolences are a free-text `authorName`, not an account
  reference — anyone, including a signed-out guest, can leave one, matching "users should be
  able to ... leave messages" without requiring registration for that specific action.

## Misses

- `composition` — no per-row ownership check independent of view-scope (see above); a
  determined member could in principle edit another member's obituary by guessing its id if
  we had granted `edit`, since the format ties view-scope and edit-scope together per role.
  We did not grant it, so this is a documented absence rather than a live gap.

## New for this app

- A `dashboards` node with `period` (date-range narrowing on `Obituary.createdAt`) and a
  `groupUnit: "month"` table alongside plain `count` cards — the "statistical analysis"
  case is a real grouped aggregate, not a hand-written report.
- An `image` field used purely for display (uploaded once at publish time, shown as a
  thumbnail on the detail page), with no edit path afterwards.
