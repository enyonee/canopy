// Row-scoped POST routes on an already-resolved entity+row: a declared
// action, a state transition ("go"), or an inline add to a related child
// table. Called from routes/entity.mjs once it has the row in hand.
import { errorPage, forbiddenPage, label, transitionsFor } from '../render.mjs';
import { detailView } from '../render/detail.mjs';

async function runAction(ctx, entity, fields, id, row) {
  const { graph, store, vc, role, user, perms, interp, trace, send, ok, parts } = ctx;
  const action = graph.actions?.find((a) => a.name === parts[3] && a.in === entity);
  if (!action) { send(404, errorPage(graph, `no action ${parts[3]} on ${entity}`)); return true; }
  // "by" names the roles; it never lifts the row scope an own-grant put there.
  const mayRun = action.by ? action.by.includes(role) && perms.ownOk(user, entity, row) : vc.can(entity, `do:${action.name}`, row);
  if (!mayRun) { ctx.deny(); return true; }
  const submitted = await ctx.body();
  let out;
  try { out = await interp.attempt(() => interp.runSteps(action.do, { rowEntity: entity, id, row, values: submitted, user })); }
  catch (e) { trace({ kind: 'refused', entity, id, action: action.name, message: e.message }); send(400, detailView(graph, store, entity, fields, row, e.message, vc)); return true; }
  ok(interp.afterPath(action.after || `/${entity}`, entity, id, { created: out.created }), action.confirm ? interp.interpolate(action.confirm, out) : '');
  return true;
}

async function runTransition(ctx, entity, fields, id, row) {
  const { graph, store, vc, role, user, interp, trace, send, ok, parts } = ctx;
  const st = graph.states?.[entity];
  const t = st?.transitions.find((x) => x.name === parts[3]);
  if (!t) { send(404, errorPage(graph, `no transition ${parts[3]} on ${entity}`)); return true; }
  if (!transitionsFor(graph, entity, row, vc).includes(t)) {
    if (!vc.can(entity, `go:${t.name}`, row) || (t.by && !t.by.includes(role))) { ctx.deny(); return true; }
    send(409, forbiddenPage(graph, vc, `${label(entity)} is ${row[st.field]}; "${t.title || label(t.name)}" is not available from here.`));
    return true;
  }
  const submitted = await ctx.body();
  const values = {};
  for (const f of t.fields || []) if (submitted[f] !== undefined) values[f] = submitted[f];
  const problems = interp.validateValues(entity, { ...values, [st.field]: t.to }, { partial: true, existing: row });
  for (const f of t.fields || []) if (values[f] === undefined || String(values[f]).trim() === '') problems.push(`${f} is required`);
  if (problems.length) { send(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc)); return true; }
  let out;
  try {
    out = await interp.attempt(() => {
      store.update(entity, id, { ...values, [st.field]: t.to });
      trace({ kind: 'transition', entity, id, name: t.name, from: row[st.field], to: t.to, who: user?.id ?? null });
      return interp.runSteps(t.do || [], { rowEntity: entity, id, values: submitted, user });
    });
  } catch (e) { trace({ kind: 'refused', entity, id, transition: t.name, message: e.message }); send(400, detailView(graph, store, entity, fields, row, e.message, vc)); return true; }
  ok(interp.afterPath(t.after || `/${entity}/${id}`, entity, id, { created: out.created }), t.confirm ? interp.interpolate(t.confirm, out) : `${label(entity)} is now ${t.to}`);
  return true;
}

async function addRelated(ctx, entity, fields, id, row) {
  const { graph, store, vc, user, perms, interp, trace, send, ok, parts } = ctx;
  const child = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[3].toLowerCase());
  const rel = (graph.override?.[`${entity}.detail`]?.related || []).find((r) => r.entity === child);
  if (!rel) { send(404, errorPage(graph, `no related ${parts[3]} on ${entity}`)); return true; }
  if (!vc.can(entity, 'view', row) || !vc.can(child, 'create')) { ctx.deny(); return true; }
  const submitted = interp.onlyWritable(child, user, await ctx.body(), rel.form || null);
  interp.checkboxes(child, submitted);
  const values = { ...submitted, [rel.via]: id, ...ctx.resolveTop(rel.fill || {}) };
  const own = perms.ownField(user, child);
  if (own) values[own] = user.id;
  const problems = interp.validateValues(child, values);
  if (problems.length) { send(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc)); return true; }
  try {
    await interp.attempt(() => {
      const kid = store.insert(child, values);
      trace({ kind: 'create', entity: child, id: kid, via: rel.via, effects: ['db.write'], who: user?.id ?? null });
      interp.fireEvents('created', child, kid, values, user);
    });
  } catch (e) { trace({ kind: 'refused', entity: child, message: e.message }); send(400, detailView(graph, store, entity, fields, row, e.message, vc)); return true; }
  ok(`/${entity}/${id}`, rel.confirm || `${label(child)} added successfully`);
  return true;
}

// entity.mjs has already checked parts[2] is one of these before calling in.
export function handleRow(ctx, entity, fields, id, row) {
  const kind = ctx.parts[2];
  if (kind === 'action') return runAction(ctx, entity, fields, id, row);
  if (kind === 'go') return runTransition(ctx, entity, fields, id, row);
  return addRelated(ctx, entity, fields, id, row);
}
