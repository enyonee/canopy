// The step interpreter: runs an action/event/transition's steps inside one
// transaction, resolves "@row.field" / "= expr" values against the row the
// steps are running on, and validates a submission against the declared
// fields and rules. No HTTP knowledge — routes/*.mjs drive this from a
// request; tests/helpers.mjs and the CLI drive it without one at all.
import { flush } from './outbox.mjs';
import { parse as parseExpr, evaluate, isExpression, stripExpression } from './expr.mjs';
import { coerce, defaultValue, formatMoney } from './spec.mjs';

// A block that refuses (not enough stock, no such row) is the application's
// answer, not a crash: attempt() turns any thrown error into a Refused so the
// caller can answer 400 with its message instead of 500.
class Refused extends Error {}

export function createInterpreter({ graph, store, registry, perms, meId, trace = (_event) => {}, fetchImpl }) {
  const CATALOG = registry.blocks;
  const exprCache = new Map();
  const compiled = (src) => { if (!exprCache.has(src)) exprCache.set(src, parseExpr(src, registry.functions)); return exprCache.get(src); };

  // --- names inside steps: "@row.x", "@me", "@created", "= qty * price", "{row.title}" ------------
  const ROWS = { row: 'rowEntity', each: 'eachEntity', found: 'foundEntity', picked: 'pickedEntity' };
  const refValue = (ctx, pathParts) => {
    const [head, ...rest] = pathParts;
    if (head === 'me') {
      const id = ctx.user ? ctx.user.id : meId;
      if (!rest.length) return id;
      const ent = graph.roles?.entity || graph.identity?.entity;
      const who = ent && store.raw(ent, id);
      return who ? store.ctx(ent, who).get(rest) : null;
    }
    if (head === 'now') return new Date().toISOString();
    if (head === 'today') return new Date().toISOString().slice(0, 10);
    if (head === 'values') return ctx.values?.[rest[0]];
    if (ROWS[head]) {
      const obj = ctx[head];
      if (!obj) return null;
      if (!rest.length || rest[0] === 'id') return obj.id;
      return store.ctx(ctx[ROWS[head]], obj).get(rest);
    }
    return rest.length ? undefined : ctx[head];
  };
  // The checker only lets bare names and aggregates through where a row exists.
  const exprCtx = (ctx) => ({
    get(p) {
      const [head] = p;
      if (['me', 'now', 'today', 'values', 'created', 'delivery'].includes(head) || ROWS[head]) return refValue(ctx, p);
      return store.ctx(ctx.rowEntity, ctx.row).get(p);
    },
    rows: (child, via) => store.ctx(ctx.rowEntity, ctx.row).rows(child, via),
  });
  const resolve = (ctx) => {
    const one = (v) => {
      if (typeof v === 'string') {
        if (v.startsWith('@')) return refValue(ctx, v.slice(1).split('.'));
        if (isExpression(v)) return evaluate(compiled(stripExpression(v)), exprCtx(ctx), registry.functions);
        return v;
      }
      if (Array.isArray(v)) return v.map(one);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
      return v;
    };
    return one;
  };
  const interpolate = (text, ctx) => String(text).replace(/\{([^}]+)\}/g, (_, p) => {
    const parts = p.trim().split('.');
    const v = refValue(ctx, parts);
    if (v === undefined || v === null) return '';
    const f = ROWS[parts[0]] && ctx[ROWS[parts[0]]] ? store.fieldAt(ctx[ROWS[parts[0]]], parts.slice(1)) : null;
    if (f?.kind === 'money') return formatMoney(Math.round(v * 100));
    return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v);
  });
  // "/Order/{order}" — a path may name fields of the row it lands on; {id} is the row id.
  const afterPath = (template, entity, id, extra = {}) => String(template).replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'id') return String(id);
    if (k in extra) return String(extra[k] ?? '');
    const row = store.raw(entity, id);
    return row && row[k] !== undefined && row[k] !== null ? String(row[k]) : '';
  });

  const withEffects = async (fn) => {
    const out = store.transaction(fn);
    await flush(store, graph, { fetchImpl, trace, registry });
    return out;
  };
  const attempt = async (fn) => {
    try { return await withEffects(fn); }
    catch (e) { if (e instanceof Refused) throw e; const r = new Refused(e.message); r.cause = e; throw r; }
  };

  // --- steps run inside the caller's transaction; effects wait in the outbox -------------------
  const runSteps = (steps, ctx) => {
    if (ctx.rowEntity && ctx.id && !ctx.row) ctx.row = store.get(ctx.rowEntity, ctx.id);
    for (const [i, step] of steps.entries()) {
      const block = CATALOG[step.block];
      const out = block.run({
        store, graph, entity: ctx.rowEntity, id: ctx.id, values: ctx.values, step, user: ctx.user,
        resolve: resolve(ctx), text: (s) => interpolate(s, ctx),
        run: (sub, extra) => runSteps(sub, { ...ctx, ...extra }),
      });
      // A block's "id" is the row it created, never the row the action runs on.
      const { id: createdId, ...rest } = out;
      Object.assign(ctx, rest);
      if (createdId) ctx.created = createdId;
      if (out.found) ctx.foundEntity = step.entity;
      if (out.picked) ctx.pickedEntity = step.from;
      if (ctx.rowEntity && ctx.id) ctx.row = store.get(ctx.rowEntity, ctx.id) || ctx.row;
      trace({ kind: 'step', i, block: step.block, effects: block.effects, entity: ctx.rowEntity, id: ctx.id,
        out: out.picked ? { picked: out.picked.id } : out.found ? { found: out.found.id } : out });
    }
    return ctx;
  };
  const fireEvents = (trigger, entity, id, values, user, snapshot = null) => {
    for (const ev of graph.events || []) {
      if (ev.on !== `${entity}.${trigger}`) continue;
      trace({ kind: 'event', on: ev.on, entity, id });
      runSteps(ev.do, { rowEntity: entity, id, row: snapshot, values, user });
    }
  };

  // --- validation: types, rules, uniqueness ------------------------------------------------------
  const validateValues = (entity, values, { partial = false, existing = null } = {}) => {
    const problems = [];
    const fields = store.fields[entity];
    for (const f of fields) {
      if (f.derive) continue;
      const v = values[f.name];
      if (partial && (v === undefined || (f.kind === 'password' && v === ''))) continue;
      if (f.required && (v === undefined || String(v).trim() === '')) { problems.push(`${f.name} is required`); continue; }
      const bad = f.type.validate(v, f);
      if (bad) problems.push(bad);
    }
    if (problems.length) return problems;
    // Rules see the row as it would be stored: the existing row under the submitted values.
    const probe = { id: existing?.id ?? 0, ...(existing || {}) };
    const asStored = (f, v) => (v === '' || v === undefined ? defaultValue(f) : coerce(f, v));
    for (const f of fields) if (!f.derive && values[f.name] !== undefined) probe[f.name] = asStored(f, values[f.name]);
    for (const f of fields) if (!f.derive && probe[f.name] === undefined) probe[f.name] = asStored(f, values[f.name]);
    for (const rule of graph.rules?.[entity] || []) {
      if (rule.unique !== undefined) {
        const v = values[rule.unique];
        if (v !== undefined && v !== '' && store.exists(entity, rule.unique, v, existing?.id)) problems.push(rule.message || `${rule.unique} is already taken`);
        continue;
      }
      let ok;
      // A rule checks the candidate row before it is stored: "probe" still holds the
      // plain submitted value of any password field, never the hash a real row has.
      // The checker makes a rule expression that throws unreachable for a valid graph;
      // this stays fail-closed on purpose (a rule the runtime cannot evaluate refuses
      // the write, it never lets it through) — see tests/interp.test.mjs.
      try { ok = evaluate(compiled(rule.check), store.ctx(entity, probe, [], { allowSecret: true }), registry.functions); }
      catch (e) { trace({ kind: 'error', message: `rule ${rule.check}: ${e.message}` }); problems.push(rule.message); continue; }
      if (!ok) problems.push(rule.message);
    }
    return problems;
  };
  // What a client may set on this entity through a form. The form's declared field
  // list is not a rendering hint: a field the form does not offer is not writable.
  // Two fields are never writable whatever the form says — the status of an entity with
  // states (transitions own it) and the role field for a user who only reaches the row
  // because they own it (otherwise editing your profile promotes you to admin).
  const writable = (entity, user, allow = null) => {
    const statusField = graph.states?.[entity]?.field;
    const own = perms.ownField(user, entity);
    const roleField = graph.roles?.entity === entity ? graph.roles.role : null;
    const banned = new Set([statusField, own].filter(Boolean));
    if (roleField && (own || !perms.can(user, entity, 'edit'))) banned.add(roleField);
    return { allow: allow ? new Set(allow) : null, banned };
  };
  const onlyWritable = (entity, user, submitted, allow = null) => {
    const { allow: list, banned } = writable(entity, user, allow);
    for (const k of Object.keys(submitted)) {
      if (banned.has(k) || (list && !list.has(k))) delete submitted[k];
    }
    return submitted;
  };
  const checkboxes = (entity, submitted) => {
    // An unchecked checkbox sends nothing. On a form submit that means false,
    // not "field absent, apply the declared default".
    const shown = graph.override?.[`${entity}.form`]?.fields;
    for (const f of store.fields[entity]) {
      if (f.kind !== 'bool' || submitted[f.name] !== undefined) continue;
      if (shown && !shown.includes(f.name)) continue;
      submitted[f.name] = 'false';
    }
    return submitted;
  };

  return {
    resolve, interpolate, afterPath, attempt, runSteps, fireEvents,
    validateValues, writable, onlyWritable, checkboxes,
  };
}
