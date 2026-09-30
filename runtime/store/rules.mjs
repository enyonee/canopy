// Rule enforcement (`/rules`: check expressions and uniqueness, single field
// or compound), attached to Store.prototype by store.mjs. This is the one
// place every write lands — Store#insert and Store#update call checkRules
// right before touching the row — so an HTTP form (through interp.mjs's
// validateValues, which calls this too), a block (db.create, db.adjust,
// db.ensure, a plugin's own store.insert/update, …) and a seed row at boot
// all meet the same rules. Calling the same function from validateValues
// means the form path reports the exact messages it always has — the logic
// lives here once, not twice.
import { parse as parseExpr, evaluate } from '../expr.mjs';
import { coerce, defaultValue } from '../spec.mjs';

// The row as it would be stored: the existing row (if any) with the
// submitted values coerced over it — what a rule's expression, or a compound
// unique check, needs to see (docs/FORMAT.md's "the row as it would be
// stored"). A secret field's *stored* value is a hash, never a value a rule
// should read (docs/FORMAT.md's own expression algebra has no way to produce
// one, and a hash is never 16 characters or null by coincidence) — carried
// over from "existing" only when it is itself the value just submitted; on
// any other write to the same row (e.g. a later step patching an unrelated
// field) it is treated as unset, same as a row that never had one.
function buildProbe(store, entity, values, existing) {
  const fields = store.fields[entity];
  const probe = { id: existing?.id ?? 0 };
  for (const [k, v] of Object.entries(existing || {})) if (!store.field(entity, k)?.type.secret) probe[k] = v;
  const asStored = (f, v) => (v === '' || v === undefined ? defaultValue(f) : coerce(f, v));
  for (const f of fields) if (!f.derive && values[f.name] !== undefined) probe[f.name] = asStored(f, values[f.name]);
  for (const f of fields) if (!f.derive && probe[f.name] === undefined) probe[f.name] = asStored(f, values[f.name]);
  return probe;
}

// The parsed expression of a check rule, cached by its source.
function ruleExpr(store, rule) {
  if (!store.ruleExprs.has(rule.check)) store.ruleExprs.set(rule.check, parseExpr(rule.check, store.registry.functions));
  return store.ruleExprs.get(rule.check);
}

// The context every check of `list` evaluates over: what they can reach (hops, aggregates, derived
// fields, all planned from the expressions) is loaded here, once, before the first is evaluated —
// evaluating them then never asks the driver anything (runtime/store/hydrate.mjs's evalCtx).
function checkCtx(store, entity, checks, probe) {
  return store.evalCtx(entity, probe, `rules:${checks.map((r) => r.check).join('\u0000')}`, checks.map((r) => ruleExpr(store, r)), true);
}

// Returns the failed rules' messages (empty when none fail). A rule whose
// expression throws refuses the write too — fail-closed on purpose, a rule
// the runtime cannot evaluate never lets the write through (tests/interp.test.mjs).
export function checkRules(entity, values, existing = null) {
  const list = this.graph.rules?.[entity];
  if (!list?.length) return [];
  const probe = buildProbe(this, entity, values, existing);
  const problems = [], checks = list.filter((r) => r.unique === undefined);
  for (const r of checks) ruleExpr(this, r); // an expression that does not parse is a crash, not a failed rule
  let ctx = null;
  for (const rule of list) {
    if (rule.unique !== undefined) {
      if (!Array.isArray(rule.unique)) {
        const v = values[rule.unique];
        if (v !== undefined && v !== '' && this.exists(entity, rule.unique, v, existing?.id)) problems.push(rule.message || `${rule.unique} is already taken`);
        continue;
      }
      // A compound unique rule may have only one of its fields on this submit
      // (the other unchanged): "probe" already merged submitted values over the
      // existing row, so it is the only place both halves of the pair are known.
      const names = rule.unique;
      const known = names.every((n) => probe[n] !== undefined && probe[n] !== null && probe[n] !== '');
      if (known && this.existsAll(entity, names, probe, existing?.id)) problems.push(rule.message || `${names.join(' + ')} must be unique together`);
      continue;
    }
    let ok;
    // A rule checks the candidate row before it is stored: "probe" still holds the
    // plain submitted value of any password field, never the hash a real row has.
    try {
      ctx ??= checkCtx(this, entity, checks, probe);
      ok = evaluate(ruleExpr(this, rule), ctx, this.registry.functions);
    } catch (e) { this.trace({ kind: 'error', message: `rule ${rule.check}: ${e.message}` }); problems.push(rule.message); continue; }
    if (!ok) problems.push(rule.message);
  }
  return problems;
}
