# creditrepair — webgen-bench/000014

## Weakened cases

- **Case 2 (credit score inquiry).** There is no credit-bureau connector in this format (only
  `http`/`mail` transports), and querying a real bureau is out of scope for a seeded prototype
  anyway. The "inquiry" is a self-report: the visitor gives four factors (payment history,
  utilization %, open accounts, late payments) and `score`/`band`/`advice` are *derived*
  deterministically from them (an `if()`/`min()`/`max()`/`round()` formula, clamped to
  300–850) — not random, not a real bureau lookup, but a transparent, reproducible estimate.
  The check submits one fixed set of inputs and asserts the exact resulting score (750) and
  band (Excellent).
- Cases 1, 3, 4 are checked as specified, no weakening.

## Misses

- `connector` — no bureau/credit-check connector kind exists (only `http`, `mail`, `payment`);
  an honest real integration would need one, out of scope here.

## New for this app

- A derived field referencing another derived field of the same entity (`band` reads `score`,
  `advice` reads `score` too) — chained derivations, still cycle-free and statically checked.
- A plain `enum` field (not the `states`-driven status field) renders its raw lowercase value
  (`poor`, `new`) with no capitalisation, unlike a state-machine status which the runtime
  renders as `<span class="status">Capitalised</span>` — worth knowing when writing checks
  against enum columns that are not the entity's state field.
