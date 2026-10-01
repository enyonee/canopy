// The step interpreter: runs an action/event/transition's steps inside one
// transaction, resolves "@row.field" / "= expr" values against the row the
// steps are running on, and validates a submission against the declared
// fields and rules. No HTTP knowledge — routes/*.mjs drive this from a
// request; tests/helpers.mjs and the CLI drive it without one at all.
import { flush } from './outbox.mjs';
import { connectorModes } from './deploy.mjs';
import { parse as parseExpr, evaluate, isExpression, stripExpression } from './expr.mjs';
import { formatMoney } from './spec.mjs';

// A block that refuses (not enough stock, no such row) is the application's
// answer, not a crash: attempt() turns any thrown error into a Refused so the
// caller can answer 400 with its message instead of 500.
class Refused extends Error {}

export function createInterpreter({ graph, store, registry, perms, meId, trace = (_event) => {}, fetchImpl, clock, env = null }) {
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
  // The store a step reads and writes through: the transaction view it runs in (`ctx.tx`), else the store itself.
  const dbOf = (ctx) => ctx.tx ?? store;
  // `path` read from `row` of `entity`: its read-set is loaded now (inside the step's transaction, so
  // the step's own earlier writes are seen), then the path is read from the snapshot.
  const pathPlans = new Map(); // "a.b" -> { key, asts }: the plan cache key and expression of a path, made once
  const readFrom = async (db, entity, row, path) => {
    const name = path.join('.');
    if (!pathPlans.has(name)) pathPlans.set(name, { key: `path:${name}`, asts: [{ t: 'path', p: path }] });
    const { key, asts } = pathPlans.get(name);
    return (await db.evalCtx(entity, row, key, asts)).get(path);
  };
  const refValue = async (ctx, pathParts) => {
    const [head, ...rest] = pathParts;
    if (head === 'me') {
      const id = ctx.user ? ctx.user.id : meId;
      if (!rest.length) return id;
      const ent = graph.roles?.entity || graph.identity?.entity;
      const who = ent && await dbOf(ctx).raw(ent, id);
      return who ? await readFrom(dbOf(ctx), ent, who, rest) : null;
    }
    if (head === 'now') return new Date().toISOString();
    if (head === 'today') return new Date().toISOString().slice(0, 10);
    if (head === 'values') return ctx.values?.[rest[0]];
    if (ROWS[head]) {
      const obj = ctx[head];
      if (!obj) return null;
      if (!rest.length || rest[0] === 'id') return obj.id;
      return await readFrom(dbOf(ctx), ctx[ROWS[head]], obj, rest);
    }
    return rest.length ? undefined : ctx[head];
  };
  // A name that is not the row's own: `me`, `values`, `each`… (refValue reads it, and loads for itself).
  const STEP_NAMES = ['me', 'now', 'today', 'values', 'created', 'delivery'];
  const isStepName = (head) => STEP_NAMES.includes(head) || Boolean(ROWS[head]);
  // The step names an expression reads, outside aggregate bodies (a body reads its own rows; only `row.<name>`
  // reaches back out). evaluate() is synchronous, so they are loaded before it starts.
  const stepPaths = (ast, out = [], inBody = false) => {
    if (ast.t === 'path') {
      if (!inBody && isStepName(ast.p[0])) out.push(ast.p);
      if (inBody && ast.p[0] === 'row' && ast.p.length > 1 && isStepName(ast.p[1])) out.push(ast.p.slice(1));
    } else if (ast.t === 'un') stepPaths(ast.a, out, inBody);
    else if (ast.t === 'bin') { stepPaths(ast.a, out, inBody); stepPaths(ast.b, out, inBody); }
    else if (ast.t === 'call') for (const a of ast.args) stepPaths(a, out, inBody);
    else if (ast.t === 'agg' && ast.body) stepPaths(ast.body, out, true);
    return out;
  };
  // The checker only lets bare names and aggregates through where a row exists. The expression is
  // planned and loaded for the row it runs on before evaluate() starts (evalCtx), and so is every step name it reads.
  const exprCtx = async (ctx, src) => {
    const ast = compiled(src);
    const base = await dbOf(ctx).evalCtx(ctx.rowEntity, ctx.row, `step:${src}`, [ast]);
    const named = new Map();
    for (const p of stepPaths(ast)) named.set(p.join('.'), await refValue(ctx, p));
    return {
      clock: base.clock,
      get(p) {
        if (!isStepName(p[0])) return base.get(p);
        if (!named.has(p.join('.'))) throw new Error(`not loaded: ${p.join('.')}`);
        return named.get(p.join('.'));
      },
      rows: (child, via) => base.rows(child, via),
      // The old lazy context had no compiled aggregates: its expressions always walked the child rows.
      ...(store.lazyEval ? {} : { agg: (node, clock) => base.agg(node, clock) }),
    };
  };
  // `resolve(ctx)` answers a function that resolves one value; it loads what the value reads, so it answers a promise.
  // Elements and entries are resolved one after the other, in order: the reads leave the store as they always did.
  const resolve = (ctx) => {
    const one = async (v) => {
      if (typeof v === 'string') {
        if (v.startsWith('@')) return await refValue(ctx, v.slice(1).split('.'));
        if (isExpression(v)) { const src = stripExpression(v); return evaluate(compiled(src), await exprCtx(ctx, src), registry.functions); }
        return v;
      }
      if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await one(x)); return out; }
      if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = await one(x); return out; }
      return v;
    };
    return one;
  };
  // "{row.title} is {status}": collect the names, load and read each value, then format. The
  // replace below only formats — nothing is loaded inside String#replace.
  const TEMPLATE = /\{([^}]+)\}/g;
  const show = (ctx, parts, v) => {
    if (v === undefined || v === null) return '';
    const f = ROWS[parts[0]] && ctx[ROWS[parts[0]]] ? store.fieldAt(ctx[ROWS[parts[0]]], parts.slice(1)) : null;
    if (f?.kind === 'money') return formatMoney(Math.round(v * 100));
    return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v);
  };
  const interpolate = async (text, ctx) => {
    const src = String(text);
    const names = [...src.matchAll(TEMPLATE)].map((m) => m[1].trim().split('.'));
    const values = [];
    for (const parts of names) values.push(await refValue(ctx, parts));
    let i = 0;
    return src.replace(TEMPLATE, () => { const at = i++; return show(ctx, names[at], values[at]); });
  };
  // "/Order/{order}" — a path may name fields of the row it lands on; {id} is the row id.
  // The row is read once, before the replace: nothing is loaded inside String#replace.
  const PLACEHOLDER = /\{(\w+)\}/g;
  const afterPath = async (template, entity, id, extra = {}) => {
    const src = String(template);
    const needsRow = [...src.matchAll(PLACEHOLDER)].some((m) => m[1] !== 'id' && !(m[1] in extra));
    const row = needsRow ? await store.raw(entity, id) : null;
    return src.replace(PLACEHOLDER, (_, k) => {
      if (k === 'id') return String(id);
      if (k in extra) return String(extra[k] ?? '');
      return row && row[k] !== undefined && row[k] !== null ? String(row[k]) : '';
    });
  };

  // Deliver what is due (after a commit, or when an operator asks); the delivery path takes its time from `clock`.
  const flushNow = async () => await flush(store, graph, { fetchImpl, trace, registry, clock, env });
  const modes = () => connectorModes(graph, registry, env ? env.deploy() : { connectors: {} });
  // `fn` gets the transaction-bound view of the store (Store#transaction) and uses it for every read and write.
  const withEffects = async (fn) => {
    const out = await store.transaction(fn);
    await flushNow();
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
  const fireCreatedFor = (ctx) => async (entity, id, values) =>
    await fireEvents('created', entity, id, values, ctx.user, null, (ctx.eventDepth || 0) + 1, ctx.tx);

  // --- steps run inside the caller's transaction; effects wait in the outbox -------------------
  // `ctx.tx` is the transaction view the steps run in (attempt hands it to its callback); without one, the store.
  const runSteps = async (steps, ctx) => {
    const db = dbOf(ctx);
    if (ctx.rowEntity && ctx.id && !ctx.row) ctx.row = await db.get(ctx.rowEntity, ctx.id);
    for (const [i, step] of steps.entries()) {
      const block = CATALOG[step.block];
      const out = await block.run({
        store: db, graph, registry, entity: ctx.rowEntity, id: ctx.id, values: ctx.values, step, user: ctx.user,
        resolve: resolve(ctx), trace, text: async (s) => await interpolate(s, ctx),
        run: async (sub, extra) => await runSteps(sub, { ...ctx, ...extra }),
        fireCreated: fireCreatedFor(ctx),
      });
      // A block's "id" is the row it created, never the row the action runs on.
      const { id: createdId, ...rest } = out;
      Object.assign(ctx, rest);
      if (createdId) ctx.created = createdId;
      if (out.found) ctx.foundEntity = step.entity;
      if (out.picked) ctx.pickedEntity = step.from;
      if (ctx.rowEntity && ctx.id) ctx.row = await db.get(ctx.rowEntity, ctx.id) || ctx.row;
      trace({ kind: 'step', i, block: step.block, effects: block.effects, entity: ctx.rowEntity, id: ctx.id,
        out: out.picked ? { picked: out.picked.id } : out.found ? { found: out.found.id } : out });
    }
    return ctx;
  };
  const fireEvents = async (trigger, entity, id, values, user, snapshot = null, depth = 0, tx = null) => {
    if (depth > MAX_EVENT_DEPTH) throw new Error(`too many nested "${trigger}" events — check for a cycle through ${entity}.${trigger}`);
    for (const ev of graph.events || []) {
      if (ev.on !== `${entity}.${trigger}`) continue;
      trace({ kind: 'event', on: ev.on, entity, id });
      await runSteps(ev.do, { rowEntity: entity, id, row: snapshot, values, user, eventDepth: depth, tx });
    }
  };

  // The steps of every event an inbound webhook triggers (`inbound: "<connector>.<type>"`), inside the caller's
  // transaction. The payload's values are the steps' `@values.<name>`; there is no row and no user.
  const fireInbound = async (connector, type, values, tx = null) => {
    for (const ev of graph.events || []) {
      if (ev.inbound !== `${connector}.${type}`) continue;
      trace({ kind: 'event', inbound: ev.inbound });
      await runSteps(ev.do, { rowEntity: null, id: null, values, user: null, tx });
    }
  };

  // --- validation: types, rules, uniqueness ------------------------------------------------------
  const validateValues = async (entity, values, { partial = false, existing = null } = {}) => {
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
    problems.push(...await store.checkRules(entity, values, existing));
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
    resolve, interpolate, afterPath, attempt, runSteps, fireEvents, fireInbound, flushNow, modes,
    validateValues, writable, onlyWritable, checkboxes, dropEmptyUploads,
  };
}
