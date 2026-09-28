// The step interpreter: runs an action/event/transition's steps inside one
// transaction, resolves "@row.field" / "= expr" values against the row the
// steps are running on, and validates a submission against the declared
// fields and rules. No HTTP knowledge — routes/*.mjs drive this from a
// request; tests/helpers.mjs and the CLI drive it without one at all.
import { flush } from './outbox.mjs';
import { parse as parseExpr, evaluate, isExpression, stripExpression } from './expr.mjs';
import { formatMoney } from './spec.mjs';

// A block that refuses (not enough stock, no such row) is the application's
// answer, not a crash: attempt() turns any thrown error into a Refused so the
// caller can answer 400 with its message instead of 500.
class Refused extends Error {}

export function createInterpreter({ graph, store, registry, perms, meId, trace = (_event) => {}, fetchImpl }) {
  // The store's write guard (Store#checkRules) traces a throwing rule's
  // underlying error the same way any other request-time failure is traced —
  // installed here, once, rather than known to the store from construction:
  // "a guard installed into the store by interp at boot" (the guard itself
  // is unconditional from Store's own construction, so a seed row is still
  // checked before this ever runs — only the trace sink needs installing).
  store.trace = trace;
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

  // A row a block creates (db.create/db.createRow/db.ensure) fires its entity's
  // "created" event exactly like an HTTP create (item 14) — through this one
  // callback, threaded into every block's run() ctx below, closed over the
  // *current* step's own nesting so a chain of created events (A.created
  // creates a B, B.created creates an A, …) is counted, not reset. A direct or
  // indirect cycle refuses instead of recursing forever; a graph that is fine
  // with "ensure a default row exists" (the created row is found, not made, on
  // the very next pass) never gets close to the limit.
  const MAX_EVENT_DEPTH = 8;
  const fireCreatedFor = (ctx) => (entity, id, values) =>
    fireEvents('created', entity, id, values, ctx.user, null, (ctx.eventDepth || 0) + 1);

  // --- steps run inside the caller's transaction; effects wait in the outbox -------------------
  const runSteps = (steps, ctx) => {
    if (ctx.rowEntity && ctx.id && !ctx.row) ctx.row = store.get(ctx.rowEntity, ctx.id);
    for (const [i, step] of steps.entries()) {
      const block = CATALOG[step.block];
      const out = block.run({
        store, graph, entity: ctx.rowEntity, id: ctx.id, values: ctx.values, step, user: ctx.user,
        resolve: resolve(ctx), text: (s) => interpolate(s, ctx),
        run: (sub, extra) => runSteps(sub, { ...ctx, ...extra }),
        fireCreated: fireCreatedFor(ctx),
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
  const fireEvents = (trigger, entity, id, values, user, snapshot = null, depth = 0) => {
    if (depth > MAX_EVENT_DEPTH) throw new Error(`too many nested "${trigger}" events — check for a cycle through ${entity}.${trigger}`);
    for (const ev of graph.events || []) {
      if (ev.on !== `${entity}.${trigger}`) continue;
      trace({ kind: 'event', on: ev.on, entity, id });
      runSteps(ev.do, { rowEntity: entity, id, row: snapshot, values, user, eventDepth: depth });
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
    // Rules (checks + uniqueness) are enforced once, in the store itself
    // (Store#checkRules, runtime/store/rules.mjs) — every write meets them
    // there: this form path, a block, and a seed row at boot all end up
    // inside Store#insert/#update. Calling the same function here means the
    // form path reports the exact messages it always has (item 20).
    problems.push(...store.checkRules(entity, values, existing));
    return problems;
  };
  // What a client may set on this entity through a form. The form's declared field
  // list is not a rendering hint: a field the form does not offer is not writable.
  // Two fields are never writable whatever the form says — the status of an entity with
  // states (transitions own it) and the role field for a user who only reaches the row
  // because they own it (otherwise editing your profile promotes you to admin).
  const writable = (entity, user, allow = null) => {
    const statusField = graph.states?.[entity]?.field;
    // Only the fillable own field (never a second-or-later own field like a
    // message's "recipient", which is an ordinary user-chosen value) is banned:
    // that is the one field a client could otherwise reassign away from itself.
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
  // A multipart file input always sends a part, even unselected: routes/context.mjs's
  // parser turns an empty upload into "" rather than dropping it, so this decides what
  // that means (item 13) — an optional file/image silently keeps its old value (or
  // stays unset on create, exactly as before), but a required one is left as an
  // explicit "" so the ordinary required-field check below refuses it for real,
  // instead of a required file quietly vanishing as if it had never been asked for.
  const dropEmptyUploads = (entity, submitted) => {
    for (const f of store.fields[entity]) {
      if (f.type.upload && submitted[f.name] === '' && !f.required) delete submitted[f.name];
    }
    return submitted;
  };

  return {
    resolve, interpolate, afterPath, attempt, runSteps, fireEvents,
    validateValues, writable, onlyWritable, checkboxes, dropEmptyUploads,
  };
}
