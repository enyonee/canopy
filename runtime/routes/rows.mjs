// Row-scoped POST routes on an already-resolved entity+row: a declared
// action, a state transition ("go"), or an inline add to a related child
// table. Called from routes/entity.mjs once it has the row in hand.
import { errorPage, forbiddenPage, label, transitionsFor, rowJSON, mayRunAction } from '../render.mjs';
import { detailView } from '../render/detail.mjs';

async function runAction(ctx, entity, fields, id, row) {
  const { graph, store, vc, user, interp, trace, ok, parts } = ctx;
  const action = graph.actions?.find((a) => a.name === parts[3] && a.in === entity);
  if (!action) { ctx.answer(404, errorPage(graph, `no action ${parts[3]} on ${entity}`), { ok: false, status: 404, errors: [`no action ${parts[3]} on ${entity}`] }); return true; }
  if (!mayRunAction(vc, entity, action, row)) { ctx.deny(); return true; }
  const submitted = await ctx.body();
  if (action.fields?.length) {
    // Item 19: a row action's declared fields are typed and required, exactly
    // like a transition's own `fields`.
    const problems = interp.validateValues(entity, submitted, { partial: true, existing: row });
    for (const f of action.fields) if (submitted[f] === undefined || String(submitted[f]).trim() === '') problems.push(`${f} is required`);
    if (problems.length) { ctx.answer(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc), { ok: false, status: 400, errors: problems }); return true; }
  }
  let out;
  try { out = await interp.attempt(() => interp.runSteps(action.do, { rowEntity: entity, id, row, values: submitted, user })); }
  catch (e) {
    trace({ kind: 'refused', entity, id, action: action.name, message: e.message });
    ctx.answer(400, detailView(graph, store, entity, fields, row, e.message, vc), { ok: false, status: 400, errors: [e.message] });
    return true;
  }
  const flash = action.confirm ? interp.interpolate(action.confirm, out) : '';
  if (ctx.wantsJSON) { const updated = store.get(entity, id); ctx.sendJson(200, { ok: true, id: updated.id, created: out.created, flash, row: rowJSON(store, entity, fields, updated, vc) }); return true; }
  ok(interp.afterPath(action.after || `/${entity}`, entity, id, { created: out.created }), flash);
  return true;
}

async function runTransition(ctx, entity, fields, id, row) {
  const { graph, store, vc, role, user, interp, trace, ok, parts } = ctx;
  const st = graph.states?.[entity];
  const t = st?.transitions.find((x) => x.name === parts[3]);
  if (!t) { ctx.answer(404, errorPage(graph, `no transition ${parts[3]} on ${entity}`), { ok: false, status: 404, errors: [`no transition ${parts[3]} on ${entity}`] }); return true; }
  if (!transitionsFor(graph, entity, row, vc).includes(t)) {
    if (!vc.can(entity, `go:${t.name}`, row) || (t.by && !t.by.includes(role))) { ctx.deny(); return true; }
    const message = `${label(entity)} is ${row[st.field]}; "${t.title || label(t.name)}" is not available from here.`;
    ctx.answer(409, forbiddenPage(graph, vc, message), { ok: false, status: 409, errors: [message] });
    return true;
  }
  const submitted = await ctx.body();
  const values = {};
  for (const f of t.fields || []) if (submitted[f] !== undefined) values[f] = submitted[f];
  const problems = interp.validateValues(entity, { ...values, [st.field]: t.to }, { partial: true, existing: row });
  for (const f of t.fields || []) if (values[f] === undefined || String(values[f]).trim() === '') problems.push(`${f} is required`);
  if (problems.length) { ctx.answer(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc), { ok: false, status: 400, errors: problems }); return true; }
  let out;
  try {
    out = await interp.attempt(() => {
      store.update(entity, id, { ...values, [st.field]: t.to });
      trace({ kind: 'transition', entity, id, name: t.name, from: row[st.field], to: t.to, who: user?.id ?? null });
      return interp.runSteps(t.do || [], { rowEntity: entity, id, values: submitted, user });
    });
  } catch (e) {
    trace({ kind: 'refused', entity, id, transition: t.name, message: e.message });
    ctx.answer(400, detailView(graph, store, entity, fields, row, e.message, vc), { ok: false, status: 400, errors: [e.message] });
    return true;
  }
  const flash = t.confirm ? interp.interpolate(t.confirm, out) : `${label(entity)} is now ${t.to}`;
  if (ctx.wantsJSON) { const updated = store.get(entity, id); ctx.sendJson(200, { ok: true, id: updated.id, created: out.created, flash, row: rowJSON(store, entity, fields, updated, vc) }); return true; }
  ok(interp.afterPath(t.after || `/${entity}/${id}`, entity, id, { created: out.created }), flash);
  return true;
}

async function addRelated(ctx, entity, fields, id, row) {
  const { graph, store, vc, user, perms, interp, trace, ok, parts } = ctx;
  const child = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[3].toLowerCase());
  const rel = (graph.override?.[`${entity}.detail`]?.related || []).find((r) => r.entity === child);
  if (!rel) { ctx.answer(404, errorPage(graph, `no related ${parts[3]} on ${entity}`), { ok: false, status: 404, errors: [`no related ${parts[3]} on ${entity}`] }); return true; }
  if (!vc.can(entity, 'view', row) || !vc.can(child, 'create')) { ctx.deny(); return true; }
  const submitted = interp.onlyWritable(child, user, await ctx.body(), rel.form || null);
  interp.checkboxes(child, submitted);
  interp.dropEmptyUploads(child, submitted);
  // "@row.*" in a related fill is the parent row (item 3): the child's own values
  // never had one, unlike a plain Entity.form's top-level "fill", which runs before
  // any row of this new entity exists.
  const fillRow = interp.resolve({ user, values: submitted, rowEntity: entity, id, row });
  const values = { ...submitted, [rel.via]: id, ...fillRow(rel.fill || {}) };
  const own = perms.ownField(user, child);
  if (own) values[own] = user.id;
  const problems = interp.validateValues(child, values);
  if (problems.length) { ctx.answer(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc), { ok: false, status: 400, errors: problems }); return true; }
  let kid;
  try {
    await interp.attempt(() => {
      kid = store.insert(child, values);
      trace({ kind: 'create', entity: child, id: kid, via: rel.via, effects: ['db.write'], who: user?.id ?? null });
      interp.fireEvents('created', child, kid, values, user);
    });
  } catch (e) {
    trace({ kind: 'refused', entity: child, message: e.message });
    ctx.answer(400, detailView(graph, store, entity, fields, row, e.message, vc), { ok: false, status: 400, errors: [e.message] });
    return true;
  }
  const flash = rel.confirm || `${label(child)} added successfully`;
  if (ctx.wantsJSON) { ctx.sendJson(200, { ok: true, id: kid, created: kid, flash, row: rowJSON(store, child, store.fields[child], store.get(child, kid), vc) }); return true; }
  ok(`/${entity}/${id}`, flash);
  return true;
}

// entity.mjs has already checked parts[2] is one of these before calling in.
export function handleRow(ctx, entity, fields, id, row) {
  const kind = ctx.parts[2];
  if (kind === 'action') return runAction(ctx, entity, fields, id, row);
  if (kind === 'go') return runTransition(ctx, entity, fields, id, row);
  return addRelated(ctx, entity, fields, id, row);
}
