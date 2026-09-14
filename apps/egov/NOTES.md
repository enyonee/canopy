# egov — webgen-bench/000047

## Weakened cases

- **Case 4 (approve a personnel management request).** Interpreted as a leave request. The
  requester's notification is an outbox letter; "reflects in the personnel records" is the
  derived `leaveDays` on the Personnel list.
- **Case 6 (decision-making submitted for internal review; all parties notified).** Review is
  a single-reviewer status (draft → review → approved/rejected by a manager), not a
  multi-step circulation; "all involved parties" are the reviewer and the initiator (two
  letters).
- **Cases 2 and 3 ("the user's procurement/leave section").** The entity lists scoped by
  `own`: staff see only their own applications; there is no separate "my" page.
- **Case 5 ("in a timely manner").** Response time is not measured.
- From the instruction, not a ui_instruct case: "design and circulate corresponding forms
  and processes" — forms and processes are fixed by the graph; there is no form designer.
  The "five powers" are modelled as the `power` enum of a decision (decision, execution,
  supervision, personnel, finance).

## Misses

- `node kind` — multi-step approval chains (several approvers in sequence, delegation) and
  a form/process designer; a transition has one `by` role list.
- `composition` — `own` scopes the whole entity for a role; a manager who is also an
  applicant sees everything, with only the status filter to narrow.
- `composition` — attendance is manual rows per day; a "clock in" action that creates
  today's row for `@me` would need a global action on a page, which cannot take values.

## New for this app

- A static page as the home with links to every section.
- `days()` in a derived int (`days(endDate, startDate) + 1`) and a rule comparing two dates
  (`endDate >= startDate`).
- `sum(LeaveRequest: if(status = 'approved', dayCount, 0))` over a derived field of the child.
- Transitions with `fields` (`decision`, `verdict`) and `by`; two `mail.send` steps in one
  transition; `db.update` with `@today`.
- `own` on five entities at once for the staff role.
