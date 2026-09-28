#!/usr/bin/env node
// The mutation gate. Coverage says the line ran; this says the tests would have
// noticed if the line were wrong. A mutation that survives is a hole in the suite.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const MUTATIONS = [
  // The four defects the apps actually found — the suite must catch each of them again.
  { name: 'bool coercion forgets numeric 1 (defect found by todo)', file: 'runtime/fields.mjs',
    find: "raw === true || raw === 1 ||", replace: "raw === true ||" },
  { name: 'a new column is not backfilled with its default (defect found by todo)', file: 'runtime/store.mjs',
    find: 'const n = this.prepare(\n            `UPDATE "${table}" SET "${f.name}"=? WHERE "${f.name}" IS NULL`).run(seed).changes;',
    replace: 'const n = 0;' },
  { name: 'an unchecked box on create falls back to the declared default (defect found by drivers)',
    file: 'runtime/interp.mjs',
    find: "      if (f.kind !== 'bool' || submitted[f.name] !== undefined) continue;\n      if (shown && !shown.includes(f.name)) continue;\n      submitted[f.name] = 'false';",
    replace: "      if (true) continue;" },
  { name: 'a boolean ignores its declared labels (regression found by todo)', file: 'runtime/fields.mjs',
    find: "    format: (v, f, { esc, labels }) => { const pair = labels?.[f.name] || ['No', 'Yes'];", replace: "    format: (v, f, { esc }) => { const pair = ['No', 'Yes'];" },

  // Storage
  { name: 'list ignores the declared filters', file: 'runtime/store/query.mjs',
    find: '    clauses.push(`"${field}"=?`);\n    vals.push(coerce(f, cmp));',
    replace: '    void field; void cmp;' },
  { name: 'search matches everything', file: 'runtime/store/query.mjs',
    find: "    cls.push('(' + search.map((f) => `LOWER(\"${f}\") LIKE ? ESCAPE '\\\\'`).join(' OR ') + ')');",
    replace: "    cls.push('(1=1)');" },
  { name: 'sort direction is inverted', file: 'runtime/store/query.mjs',
    find: "sort.dir === 'asc' ? 'ASC' : 'DESC'", replace: "sort.dir === 'asc' ? 'DESC' : 'ASC'" },
  { name: 'aggregate ignores the grouping', file: 'runtime/store/query.mjs',
    find: "  if (groupBy) sql += ' GROUP BY grp';", replace: "  if (false) sql += '';" },
  { name: 'insert ignores declared defaults', file: 'runtime/store.mjs',
    find: "      const use = given === undefined || given === '' ? defaultValue(f) : Store.prepareValue(f, this.checkValue(entity, f, given));",
    replace: "      const use = given === undefined || given === '' ? null : Store.prepareValue(f, this.checkValue(entity, f, given));" },
  { name: 'a removed field is dropped silently', file: 'runtime/store.mjs',
    find: "      if (orphan.length && !this.graph.allowDestructive) {", replace: "      if (false) {" },

  // The checker
  { name: 'unknown blocks are accepted', file: 'runtime/check/steps.mjs',
    find: "      if (!block) {", replace: "      if (false) {" },
    // (the following lines still run; the point is that the error is never raised)
  { name: 'unknown fields in a view are accepted', file: 'runtime/check/scope.mjs',
    find: "    if (!known(e).includes(f)) {", replace: "    if (false) {" },
  { name: 'a related section may point anywhere', file: 'runtime/check/override.mjs',
    find: "      else if (f.target !== entity) err(`${p}/via`, `\"${rel.via}\" points at ${f.target}, not ${entity}`);",
    replace: "      else if (false) err(`${p}/via`, 'x');" },
  { name: 'block requirements are not enforced', file: 'runtime/check/steps.mjs',
    find: "        if (step[req] === undefined) err(p, `block \"${step.block}\" requires \"${req}\"`, block.summary);",
    replace: "        void req;" },
  { name: 'suggestions are dropped from error hints', file: 'runtime/check/scope.mjs',
    find: "      n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${e}` : `known fields: ${known(e).join(', ')}`);",
    replace: "      `known fields: ${known(e).join(', ')}`);" },

  // The interpreter
  { name: 'required fields are not enforced on submit', file: 'runtime/interp.mjs',
    find: "      if (f.required && (v === undefined || String(v).trim() === '')) { problems.push(`${f.name} is required`); continue; }",
    replace: "      void v;" },
  { name: 'a number field accepts letters', file: 'runtime/fields.mjs',
    find: "    validate: (v, f) => {\n      if (v === undefined || v === '' || v === null) return null;\n      if (Number.isNaN(Number(v))) return `${f.name} must be a number`;\n      return Number.isInteger(Number(v)) ? null : `${f.name} must be a whole number`;\n    },",
    replace: "    validate: () => null," },
  { name: 'an enum accepts values outside its set', file: 'runtime/fields.mjs',
    find: "    validate: (v, f) => (v && !f.options.includes(String(v)) ? `${f.name} must be one of: ${f.options.join(', ')}` : null),",
    replace: "    validate: () => null," },
  { name: 'a plugin may silently replace a built-in', file: 'runtime/registry.mjs',
    find: "      if (registry[table][key]) throw new Error(", replace: "      if (false) throw new Error(" },
  { name: 'a block with a connector accepts any connector kind', file: 'runtime/check/steps.mjs',
    find: "        else if (c.kind !== block.connector) err(`${p}/connector`, `connector \"${step.connector}\" is ${c.kind}, ${step.block} needs ${block.connector}`);", replace: "" },
  { name: "a plugin block's own check never runs", file: 'runtime/check/steps.mjs',
    find: "      if (block.check) block.check(step, { err, fields, entity, graph, path: p, checkEntity, checkField });", replace: "" },
  { name: "a plugin transport's declaration is not checked", file: 'runtime/check/connectors.mjs',
    find: "    for (const [key, message, hint] of transport.validate(c)) err(`${p}/${key}`, message, hint);", replace: "" },
  { name: 'a field kind skips its own validation', file: 'runtime/interp.mjs',
    find: "      const bad = f.type.validate(v, f);\n      if (bad) problems.push(bad);", replace: "" },
  { name: 'events never fire', file: 'runtime/interp.mjs',
    find: "      runSteps(ev.do, { rowEntity: entity, id, row: snapshot, values, user, eventDepth: depth });", replace: "      void ev;" },
  { name: 'identity resolves to nothing', file: 'runtime/interp.mjs',
    find: "      const id = ctx.user ? ctx.user.id : meId;", replace: "      const id = null;" },
  { name: 'seed rows are inserted on every boot', file: 'runtime/boot.mjs',
    find: "  const remaining = new Set(seedEntities.filter((e) => !store.count(e)));",
    replace: "  const remaining = new Set(seedEntities);" },
  { name: 'the confirmation never reaches the page', file: 'runtime/routes/context.mjs',
    find: "  const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);",
    replace: "  const ok = (to) => redirect(to);" },
  { name: 'a rejected form is stored anyway', file: 'runtime/routes/entity.mjs',
    find: "  if (problems.length) {\n    trace({ kind: 'rejected', entity, problems });\n    ctx.answer(400, formView(graph, store, entity, fields, submitted, 'new', problems, vc), { ok: false, status: 400, errors: problems });\n    return true;\n  }",
    replace: "  void problems;" },

  // Blocks
  { name: 'toggle only ever sets, never clears', file: 'runtime/blocks.mjs',
    find: "      store.update(entity, id, { [step.field]: row[step.field] ? 0 : 1 });",
    replace: "      store.update(entity, id, { [step.field]: 1 });" },
  { name: 'grading becomes case sensitive', file: 'runtime/blocks.mjs',
    find: "      const ok = target && String(target[step.against]).trim().toLowerCase()\n        === String(row[step.field]).trim().toLowerCase() ? 1 : 0;",
    replace: "      const ok = target && String(target[step.against]) === String(row[step.field]) ? 1 : 0;" },
  { name: 'weights are ignored when picking', file: 'runtime/blocks.mjs',
    find: "      const weights = rows.map((r) => (step.weight ? Math.max(0, Number(r[step.weight]) || 0) : 1));",
    replace: "      const weights = rows.map(() => 1);" },

  // Rendering and patching
  { name: 'html escaping is disabled', file: 'runtime/render.mjs',
    find: "const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) =>",
    replace: "const esc = (s) => String(s ?? '').replace(/[\\u0000]/g, (c) =>" },
  { name: 'a reference renders as its raw id', file: 'runtime/fields.mjs',
    find: "    format: (v, f, { esc, store }) => { const lbl = store.labelOf(f.target, v); return lbl ? `<a href=\"/${f.target}/${v}\">${esc(lbl)}</a>` : '—'; },",
    replace: "    format: (v, f, { esc }) => esc(v)," },
  { name: 'appending to an array overwrites its first item', file: 'runtime/patch.mjs',
    find: "    else if (last === '-' && Array.isArray(node)) node.push(op.value);",
    replace: "    else if (last === '-' && Array.isArray(node)) node[0] = op.value;" },
  // --- v2: roles, sessions, ownership ---
  { name: 'a wrong password logs in', file: 'runtime/auth.mjs',
    find: "  return probe.length === known.length && crypto.timingSafeEqual(probe, known);", replace: "  return true;" },
  { name: 'a forged session token is accepted', file: 'runtime/auth.mjs',
    find: "    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;", replace: "" },
  { name: 'every password hashes with the same salt', file: 'runtime/auth.mjs',
    find: "  const salt = crypto.randomBytes(8).toString('hex');", replace: "  const salt = 'abcd';" },
  { name: '"own" rows are not enforced', file: 'runtime/auth.mjs',
    find: "  if (unscoped || !e.own || !row || op === 'create') return true;\n  return user ? ownedMatch(store, entity, row, e.own, user.id) : false;\n}",
    replace: "  return true;\n}" },
  { name: 'the go:* and do:* wildcards stop matching', file: 'runtime/auth.mjs',
    find: "  || (op.includes(':') && ops.includes(`${op.split(':')[0]}:*`));", replace: "  || false;" },
  { name: 'a role-gated list is visible to everyone', file: 'runtime/auth.mjs',
    find: "      return Boolean(role) && item.roles.includes(role);", replace: "      return true;" },
  { name: 'the owner is not filled from the session on create', file: 'runtime/routes/entity.mjs',
    find: "  const own = perms.ownField(user, entity);\n  if (own) values[own] = user.id;\n  const problems = interp.validateValues(entity, values);",
    replace: "  const problems = interp.validateValues(entity, values);" },
  { name: 'a list shows other people\'s rows', file: 'runtime/routes/entity.mjs',
    find: "  Object.assign(where, ownWhere(entity)); // a filter may narrow the row set, never widen it",
    replace: "" },
  { name: 'the login form accepts any password', file: 'runtime/routes/session.mjs',
    find: "    if (!found || !verifyPassword(form.password, found[graph.roles.password])) {", replace: "    if (!found) {" },
  { name: 'a download skips the permission check', file: 'runtime/routes/system.mjs',
    find: "  if (!vc.can(entity, 'view', row)) { ctx.deny(); return true; }\n  const at = path.join(filesDir, path.basename(row[fieldName]));",
    replace: "  const at = path.join(filesDir, path.basename(row[fieldName]));" },
  { name: 'entities a role cannot view stay in the menu', file: 'runtime/render.mjs',
    find: "    if (ov.hidden || !vc.can(entity, 'view')) continue;", replace: "    if (ov.hidden) continue;" },

  // --- v2: rules, transitions, actions, effects ---
  // Round 6 moved rule enforcement from interp.mjs into Store#checkRules
  // (runtime/store/rules.mjs) so a block/seed write meets it too, not only an
  // HTTP form — same defects, new file (TESTS.md's refactor convention).
  { name: 'a failing check rule is ignored', file: 'runtime/store/rules.mjs',
    find: "    if (!ok) problems.push(rule.message);", replace: "    void ok;" },
  { name: 'a unique rule never fires', file: 'runtime/store/rules.mjs',
    find: "        if (v !== undefined && v !== '' && this.exists(entity, rule.unique, v, existing?.id)) problems.push(rule.message || `${rule.unique} is already taken`);", replace: "        void v;" },
  // Round 6: rules now guard every write, not only an HTTP form (item 20) —
  // these two disable that guard specifically for a block's own insert/update
  // (interp.validateValues, and so every HTTP form test, would still be
  // green: the guard it targets is the store's, reached only by a block or a
  // seed row — see tests/interp.test.mjs's "a plugin block…"/"a built-in
  // block (db.update)…" tests, which are the only things that catch these).
  { name: 'item 20: a block\'s own insert has no path to the rule guard', file: 'runtime/store.mjs',
    find: "    // The guard: every insert meets rules here, whatever wrote it (item 20).\n    const problems = this.checkRules(entity, values, null);\n    if (problems.length) throw new Error(problems[0]);",
    replace: "" },
  { name: 'item 20: a block\'s own update has no path to the rule guard', file: 'runtime/store.mjs',
    find: "    // The guard: every update meets rules here too, against the row as it\n    // would be stored (existing row + these values) — item 20.\n    const problems = this.checkRules(entity, values, this.raw(entity, id));\n    if (problems.length) throw new Error(problems[0]);",
    replace: "" },
  { name: 'uniqueness collides with the row itself', file: 'runtime/store.mjs',
    find: "    const sql = f?.type.exprKind === 'text' && typeof v === 'string'\n      ? `SELECT id FROM \"${entity.toLowerCase()}\" WHERE LOWER(\"${field}\")=LOWER(?) AND id!=?`\n      : `SELECT id FROM \"${entity.toLowerCase()}\" WHERE \"${field}\"=? AND id!=?`;\n    return Boolean(this.prepare(sql).get(v, Number(excludeId ?? 0)));",
    replace: "    const sql = f?.type.exprKind === 'text' && typeof v === 'string'\n      ? `SELECT id FROM \"${entity.toLowerCase()}\" WHERE LOWER(\"${field}\")=LOWER(?)`\n      : `SELECT id FROM \"${entity.toLowerCase()}\" WHERE \"${field}\"=?`;\n    return Boolean(this.prepare(sql).get(v));" },
  { name: 'a transition ignores the status it starts from', file: 'runtime/render.mjs',
    find: "    if (from && !from.includes(row[st.field])) return false;", replace: "" },
  { name: 'a transition ignores who may take it', file: 'runtime/render.mjs',
    find: "    if (t.by && !t.by.includes(vc.role)) return false;", replace: "" },
  { name: 'the fields a transition asks for are optional', file: 'runtime/routes/rows.mjs',
    find: "  for (const f of t.fields || []) if (values[f] === undefined || String(values[f]).trim() === '') problems.push(`${f} is required`);", replace: "" },
  { name: 'a refused block commits what it did before failing', file: 'runtime/store.mjs',
    find: "    catch (e) { this.db.exec('ROLLBACK'); throw e; }", replace: "    catch (e) { this.db.exec('COMMIT'); throw e; }" },
  { name: 'the outbox is never flushed after a commit', file: 'runtime/interp.mjs',
    find: "    const out = store.transaction(fn);\n    await flush(store, graph, { fetchImpl, trace, registry });\n    return out;", replace: "    return store.transaction(fn);" },
  { name: 'a non-2xx answer counts as delivered', file: 'runtime/transports.mjs',
    find: "      return { code: res.status, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : `HTTP ${res.status}` };",
    replace: "      return { code: res.status, status: 'sent', error: null };" },
  { name: 'attempts are never counted', file: 'runtime/outbox.mjs',
    find: "  const patch = { attempts: (row.attempts || 0) + 1 };", replace: "  const patch = { attempts: 1 };" },
  { name: 'updated events never fire', file: 'runtime/routes/entity.mjs',
    find: "      interp.fireEvents('updated', entity, id, submitted, user);", replace: "" },
  { name: 'db.adjust ignores its floor', file: 'runtime/blocks.mjs',
    find: "      if (step.min !== undefined && next < step.min) throw new Error(step.message || `${target}.${step.field} cannot go below ${step.min}`);", replace: "" },
  { name: 'db.adjust moves money in minor units', file: 'runtime/blocks.mjs',
    find: "      if (f.kind === 'money') by = toMinor(by);", replace: "" },
  { name: 'db.ensure always creates', file: 'runtime/blocks.mjs',
    find: "      if (hit) return { found: hit, made: false };", replace: "" },
  { name: 'db.each ignores its where', file: 'runtime/blocks.mjs',
    find: "      const rows = store.list(step.from, { where: resolve(step.where || {}), sort: { field: 'id', dir: 'asc' } });",
    replace: "      const rows = store.list(step.from, { sort: { field: 'id', dir: 'asc' } });" },
  { name: 'an empty upload replaces the stored file', file: 'runtime/interp.mjs',
    find: "      if (f.type.upload && submitted[f.name] === '' && !f.required) delete submitted[f.name];", replace: "" },
  { name: 'the flash is lost on the home redirect', file: 'runtime/routes/views.mjs',
    find: "  const keep = (to) => (flash ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(flash)}` : to);", replace: "  const keep = (to) => to;" },

  { name: 'a created row replaces the row the action runs on', file: 'runtime/interp.mjs',
    find: "      const { id: createdId, ...rest } = out;\n      Object.assign(ctx, rest);", replace: "      const createdId = out.id;\n      Object.assign(ctx, out);" },

  { name: 'a related table shows rows the viewer does not own', file: 'runtime/render/detail.mjs',
    find: "where: { [rel.via]: row.id, ...vc.ownWhere(rel.entity) }", replace: "where: { [rel.via]: row.id }" },
  { name: '@me.field ignores the field', file: 'runtime/interp.mjs',
    find: "      if (!rest.length) return id;\n      const ent = graph.roles?.entity || graph.identity?.entity;", replace: "      return id;\n      const ent = graph.roles?.entity || graph.identity?.entity;" },
  { name: 'a form landed on loses the flash', file: 'runtime/routes/entity.mjs',
    find: "send(200, formView(graph, store, entity, fields, {}, 'new', [], vc, flash))", replace: "send(200, formView(graph, store, entity, fields, {}, 'new', [], vc))" },
  { name: 'aggregate bodies are resolved against the outer entity', file: 'runtime/check/data.mjs',
    find: "          } else if (n.t === 'agg') { if (entities.includes(n.entity) && n.body) walk(n.body, n.entity, e); }", replace: "          } else if (n.t === 'agg') { if (entities.includes(n.entity) && n.body) walk(n.body, e, e); }" },

  { name: 'a refusal inside a created event is a crash', file: 'runtime/routes/entity.mjs',
    find: "  } catch (e) {\n    trace({ kind: 'refused', entity, message: e.message });\n    ctx.answer(400, formView(graph, store, entity, fields, submitted, 'new', [e.message], vc), { ok: false, status: 400, errors: [e.message] });\n    return true;\n  }",
    replace: "  } catch (e) { throw e; }" },

  // --- round 3: lists, export, correlated aggregates, dates, images ---
  { name: 'sorting ignores the direction', file: 'runtime/routes/context.mjs',
    find: "return { field, dir: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc' };", replace: "return { field, dir: 'asc' };" },
  { name: 'paging shows every row on every page', file: 'runtime/store/query.mjs',
    find: "  const raw = this.listRawPage(entity, opts, pageSize, (at - 1) * pageSize);",
    replace: "  const raw = this.listRawPage(entity, opts, total, 0);" },
  { name: 'paging shows every row on every page (the full-scan fallback path)', file: 'runtime/store/query.mjs',
    find: "    return { rows: rows.slice((at - 1) * pageSize, at * pageSize), total: rows.length, page: at, pages };",
    replace: "    return { rows, total: rows.length, page: at, pages };" },
  { name: 'csv cells are never quoted', file: 'runtime/render.mjs',
    find: "return /[\",\\n\\r]/.test(s) ? `\"${s.replace(/\"/g, '\"\"')}\"` : s;", replace: "return s;" },
  { name: 'a correlated aggregate reads the child instead of the outer row', file: 'runtime/expr.mjs',
    find: "        const rows = ctx.rows(n.entity, n.via).map((r) => ({ get: (p) => (p[0] === 'row' && p.length > 1 ? ctx.get(p.slice(1)) : r.get(p)), rows: r.rows, clock }));",
    replace: "        const rows = ctx.rows(n.entity, n.via);" },
  { name: 'addDays subtracts', file: 'runtime/functions.mjs',
    find: "d.setUTCDate(d.getUTCDate() + Math.round(a[1]));", replace: "d.setUTCDate(d.getUTCDate() - Math.round(a[1]));" },
  { name: 'max over dates picks the earliest', file: 'runtime/expr.mjs',
    find: "        if (typeof vals[0] === 'string') return vals.reduce((a, b) => (n.fn === 'min' ? (b < a ? b : a) : (b > a ? b : a)));",
    replace: "        if (typeof vals[0] === 'string') return vals.reduce((a, b) => (b < a ? b : a));" },
  { name: 'an image is served as a download even inline', file: 'runtime/routes/system.mjs',
    find: "  const inline = url.searchParams.get('inline') === '1' && mime;", replace: "  const inline = false;" },
  { name: '{created} in an after path is dropped', file: 'runtime/interp.mjs',
    find: "    if (k in extra) return String(extra[k] ?? '');", replace: "" },
  { name: 'a where on id matches nothing', file: 'runtime/store/query.mjs',
    find: "    const f = field === 'id' ? { kind: 'int', type: this.registry.fields.int } : this.field(entity, field);",
    replace: "    const f = this.field(entity, field);" },

  // --- v2: expressions, money, derived fields ---
  { name: 'a comparison forgets the additive level', file: 'runtime/expr.mjs',
    find: "const parseCmp = (st) => {\n  const a = parseAdd(st);", replace: "const parseCmp = (st) => {\n  const a = parseMul(st);" },
  { name: 'null poisons arithmetic instead of propagating', file: 'runtime/expr.mjs',
    find: "        if (a == null || b == null) return n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=' ? false : null;", replace: "" },
  { name: 'days() counts hours', file: 'runtime/functions.mjs',
    find: "  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);",
    replace: "  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);" },
  { name: 'a sum counts nulls as zero rows', file: 'runtime/expr.mjs',
    find: "        const vals = rows.map((r) => evaluate(n.body, r, functions)).filter((v) => v !== null && v !== undefined);", replace: "        const vals = rows.map((r) => evaluate(n.body, r, functions));" },
  { name: 'money is stored in major units', file: 'runtime/fields.mjs',
    find: "  return Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toFixed(6)));",
    replace: "  return Math.round(n);" },
  { name: 'an expression reads money in minor units', file: 'runtime/store/ctx.mjs',
    find: "    const v = toExpr(f, f.derive ? store.derived(entity, row, f, this.stack, cache) : row[head]);",
    replace: "    const v = f.derive ? store.derived(entity, row, f, this.stack, cache) : row[head];" },
  { name: 'derived fields are not computed on read', file: 'runtime/store.mjs',
    find: "    for (const f of this.fields[entity]) if (f.derive) out[f.name] = this.derived(entity, row, f, [], cache);", replace: "" },
  { name: 'a range on a derived field compares in the wrong units', file: 'runtime/store/query.mjs',
    find: "  const c = (x) => (f ? coerce(f, x) : x);", replace: "  const c = (x) => x;" },
  { name: 'gte means gt', file: 'runtime/store/query.mjs',
    find: "const OPS = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' };", replace: "const OPS = { gte: '>', lte: '<=', gt: '>', lt: '<', ne: '!=' };" },
  { name: 'month buckets are whole dates', file: 'runtime/store/query.mjs',
    find: "const UNITS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };", replace: "const UNITS = { day: '%Y-%m-%d', month: '%Y-%m-%d', year: '%Y' };" },
  { name: 'a password column passes the checker', file: 'runtime/check/scope.mjs',
    find: "    if (secret && fields[e][f].type.secret) { err(path, `\"${f}\" is a ${fields[e][f].kind} and is never shown`, 'drop it from the columns'); return false; }", replace: "" },
  { name: 'money renders in minor units', file: 'runtime/fields.mjs',
    find: "export const formatMoney = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2));", replace: "export const formatMoney = (v) => (v === null || v === undefined ? '' : String(v));" },

  // --- v2: the checker ---
  { name: 'unreachable statuses pass the checker', file: 'runtime/check/states.mjs',
    find: "    if (dead.length) err(`${p}/transitions`, `no transition leads to: ${dead.join(', ')}`, `add a transition \"to\" each, or drop it from ${entity}.${st.field}`);", replace: "" },
  { name: 'unknown operations pass the role matrix', file: 'runtime/check/roles.mjs',
    find: "    err(path, `unknown operation \"${op}\"`,", replace: "    return err(null, `unknown operation \"${op}\"`," },
  { name: 'a derived cycle passes the checker', file: 'runtime/check/data.mjs',
    find: "  if (found) err(`/data/${found.key.replace('.', '/')}`, `derived fields depend on each other: ${found.c.join(' → ')}`, 'one of them has to be stored');", replace: "" },
  { name: 'bad expressions pass the checker', file: 'runtime/check/scope.mjs',
    find: "    catch (e) { err(path, `bad expression: ${e.message}`, `expression: ${src}`); return null; }", replace: "    catch (e) { return null; }" },
  { name: 'unknown top-level nodes pass the checker', file: 'runtime/check/basics.mjs',
    find: "    if (!TOP.includes(k)) {", replace: "    if (false) {" },
  { name: 'an unknown @reference passes the checker', file: 'runtime/check/scope.mjs',
    find: "      return err(path, `unknown reference \"${v}\"`,", replace: "      return void err(null, `unknown reference \"${v}\"`," },

  // --- R3: the refactor's own new gates and fixes ---
  { name: 'a throwing rule passes instead of refusing the write (fail-open regression)', file: 'runtime/store/rules.mjs',
    find: "    catch (e) { this.trace({ kind: 'error', message: `rule ${rule.check}: ${e.message}` }); problems.push(rule.message); continue; }",
    replace: "    catch (e) { this.trace({ kind: 'error', message: `rule ${rule.check}: ${e.message}` }); ok = true; }" },
  { name: 'anonymous access is never asked to sign in', file: 'runtime/server.mjs',
    find: "  if (ctx.perms.enabled && !ctx.role) { ctx.deny('Please sign in.'); return; }", replace: "" },

  // --- R2: widgets, JSON answers, charts, schedule ---
  { name: 'a secret field reaches a JSON answer', file: 'runtime/render.mjs',
    find: "  for (const f of fields) if (!f.type.secret) out[f.name] = mayReadField(store.graph, entity, f.name, row, vc) ? toJSON(row[f.name], f) : null;",
    replace: "  for (const f of fields) out[f.name] = toJSON(row[f.name], f);" },
  { name: 'a denied JSON request gets an HTML/redirect answer instead of a JSON body', file: 'runtime/routes/context.mjs',
    find: "    if (wantsJSON) return sendJson(403, { ok: false, status: 403, errors: [message || 'You are not allowed to do this.'] });", replace: "" },
  { name: 'anyone may run a schedule by hand, not only an operator', file: 'runtime/routes/schedule.mjs',
    find: "  if (!vc.outbox) { ctx.deny('Only an operator may run a schedule by hand.'); return true; }", replace: "" },
  { name: "a chart's axis label shows raw storage units instead of the money-formatted value", file: 'runtime/render/dashboard.mjs',
    find: "  const maxDisplay = metricValue(store, chart.entity, chart.metric.fn === 'count' ? null : chart.metric.field, max);",
    replace: "  const maxDisplay = String(max);" },

  // --- this round: 13 format gaps plus two bugs the app agents found ---
  { name: 'item 1: a one-hop "own" path never matches (a note is never one\'s own through its profile)', file: 'runtime/auth.mjs',
    find: "  const parent = store.raw(f.target, refId);\n  return parent ? String(parent[subField]) === String(userId) : false;",
    replace: "  return false;" },
  { name: 'item 2: a "by"-gated row action button ignores "by" and asks the matrix alone again', file: 'runtime/render.mjs',
    find: "    if (!(act ? mayRunAction(vc, entity, act, r) : vc.can(entity, `do:${a}`, r))) return '';",
    replace: "    if (!vc.can(entity, `do:${a}`, r)) return '';" },
  { name: "item 3: a related fill can't read the parent row again (@row.* resolves to nothing)", file: 'runtime/routes/rows.mjs',
    find: "  const fillRow = interp.resolve({ user, values: submitted, rowEntity: entity, id, row });",
    replace: "  const fillRow = interp.resolve({ user, values: submitted });" },
  { name: 'item 4: a compound unique rule checks the submitted values instead of the stored row, and misses an untouched field', file: 'runtime/store/rules.mjs',
    find: "      if (known && this.existsAll(entity, names, probe, existing?.id)) problems.push(rule.message || `${names.join(' + ')} must be unique together`);",
    replace: "      if (known && this.existsAll(entity, names, values, existing?.id)) problems.push(rule.message || `${names.join(' + ')} must be unique together`);" },
  { name: 'item 5: db.set ignores "entity" and updates the current row instead', file: 'runtime/blocks.mjs',
    find: "    run: ({ store, step, resolve }) => { store.update(step.entity, resolve({ v: step.id }).v, resolve(step.set)); return {}; },",
    replace: "    run: ({ store, entity, step, resolve }) => { store.update(entity, resolve({ v: step.id }).v, resolve(step.set)); return {}; }," },
  { name: 'item 6: an embedded page form ignores the "create" permission', file: 'runtime/render/pages.mjs',
    find: "    if (!vc.can(s.form, 'create')) return '';",
    replace: "" },
  { name: 'item 7: /search ignores per-entity view permission', file: 'runtime/routes/views.mjs',
    find: "  const results = graph.search.entities.filter((e) => vc.can(e, 'view')).map((entity) => {",
    replace: "  const results = graph.search.entities.map((entity) => {" },
  { name: 'item 8: a "viewed" event never fires, even when one is declared', file: 'runtime/routes/entity.mjs',
    find: "  if (!(graph.events || []).some((ev) => ev.on === `${entity}.viewed`)) return row;",
    replace: "  return row;" },
  { name: "item 9: hours() answers in the wrong unit (minutes' divisor)", file: 'runtime/functions.mjs',
    find: "    run: (a) => { const x = toInstant(a[0]), y = toInstant(a[1]); return x && y ? Math.round((+x - +y) / hourMs * 1e6) / 1e6 : null; } },",
    replace: "    run: (a) => { const x = toInstant(a[0]), y = toInstant(a[1]); return x && y ? Math.round((+x - +y) / minuteMs * 1e6) / 1e6 : null; } }," },
  { name: "item 10: a role's byRole field list is never consulted", file: 'runtime/render/form.mjs',
    find: "export const formFieldsFor = (ov, role) => ov.byRole?.[role]?.fields ?? ov.fields;",
    replace: "export const formFieldsFor = (ov, role) => ov.fields;" },
  { name: 'item 11: a seeded file is linked without ever being copied into files/', file: 'runtime/boot.mjs',
    find: "    fs.copyFileSync(path.join(appDir, v.from), path.join(filesDir, name));",
    replace: "" },
  { name: 'item 12: a derived field may not read "id" any more', file: 'runtime/check/scope.mjs',
    find: "      if (head === 'id') {\n        if (rest.length) throw new Error(`${entity}.id is a number, cannot read .${rest[0]} of it`);\n        return 'number';\n      }",
    replace: "" },
  { name: 'item 14: a row a block creates never fires its own "created" event', file: 'runtime/interp.mjs',
    find: "        fireCreated: fireCreatedFor(ctx),",
    replace: "        fireCreated: () => {}," },
  { name: 'item 14: a cycle of "created" events never refuses, it just recurses', file: 'runtime/interp.mjs',
    find: '    if (depth > MAX_EVENT_DEPTH) throw new Error(`too many nested "${trigger}" events — check for a cycle through ${entity}.${trigger}`);',
    replace: '' },
  { name: "item 15: Entity.form's confirm/confirmEdit stop interpolating the written row", file: 'runtime/routes/entity.mjs',
    find: "  const flash = formOv.confirm ? interp.interpolate(formOv.confirm, { rowEntity: entity, row: createdRow, id, created: id }) : `${label(entity)} saved successfully`;",
    replace: "  const flash = formOv.confirm || `${label(entity)} saved successfully`;" },

  // --- more gaps confirmed by app agents, addressed after 1-15 ---
  { name: 'item 16: "ne: null" is silently dropped again instead of meaning IS NOT NULL', file: 'runtime/store/query.mjs',
    find: "        if (op === 'ne' && v === null) { clauses.push(`\"${field}\" IS NOT NULL`); continue; }\n        if (v === undefined || v === '' || v === null) continue;",
    replace: "        if (v === undefined || v === '' || v === null) continue;" },
  { name: 'item 17: a "private" field is never redacted, from anyone, anywhere', file: 'runtime/render.mjs',
    find: "function mayReadField(graph, entity, field, row, vc = anyone) {\n  const owner = graph?.override?.[`${entity}.detail`]?.private?.[field];\n  if (!owner || !row) return true;\n  if (vc.isAdmin) return true;\n  return vc.user ? String(row[owner]) === String(vc.user.id) : false;\n}",
    replace: "function mayReadField() { return true; }" },
  { name: 'item 18: a widget prop never resolves "@row.field" server-side', file: 'runtime/render.mjs',
    find: "  for (const [k, v] of Object.entries(props)) if (typeof v === 'string' && v.startsWith('@row.')) props[k] = row ? row[v.slice(5)] : null;",
    replace: "" },
  { name: "item 19: a row action's declared fields are never required", file: 'runtime/routes/rows.mjs',
    find: "  if (action.fields?.length) {\n    // Item 19: a row action's declared fields are typed and required, exactly\n    // like a transition's own `fields`.\n    const problems = interp.validateValues(entity, submitted, { partial: true, existing: row });\n    for (const f of action.fields) if (submitted[f] === undefined || String(submitted[f]).trim() === '') problems.push(`${f} is required`);\n    if (problems.length) { ctx.answer(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc), { ok: false, status: 400, errors: problems }); return true; }\n  }",
    replace: "" },

  // --- round 7: indexes, page-before-hydrate, batched aggregates, prepared cache ---
  { name: 'round 7: a ref column never gets an index', file: 'runtime/store/migrate.mjs',
    find: "  for (const f of store.fields[entity] || []) if (f.kind === 'ref') add([f.name]);",
    replace: "" },
  { name: 'round 7: a no-longer-desired index is never dropped, only ever added', file: 'runtime/store/migrate.mjs',
    find: "    if (keep.has(name)) continue;\n    this.db.exec(`DROP INDEX IF EXISTS \"${name}\"`);",
    replace: "    if (true) continue;\n    this.db.exec(`DROP INDEX IF EXISTS \"${name}\"`);" },
  { name: "round 7: the batched child fetch's IN-list is never coerced to match a ref column's TEXT storage, so every group comes up empty", file: 'runtime/store/query.mjs',
    find: "    const vals = ids.slice(i, i + IN_CHUNK).map(String);",
    replace: "    const vals = ids.slice(i, i + IN_CHUNK);" },
  { name: 'round 7: a batched aggregate groups children by the wrong (uncoerced) key, so every group comes up empty (moved to store/hydrate.mjs in R8)', file: 'runtime/store/hydrate.mjs',
    find: "      const grouped = new Map(ids.map((id) => [String(id), []]));\n      for (const r of rows) grouped.get(String(r[via]))?.push(r);",
    replace: "      const grouped = new Map(ids.map((id) => [id, []]));\n      for (const r of rows) grouped.get(r[via])?.push(r);" },
  { name: 'round 7: a nested aggregate (a chain of two or more hops) never prefetches past the first level (moved to store/hydrate.mjs in R8)', file: 'runtime/store/hydrate.mjs',
    find: "      const childIds = rows.map((r) => r.id);\n      if (childIds.length) this.buildAggCache(agg.entity, childIds, cache, seen);",
    replace: "" },
  { name: 'round 7: a page always takes the cheap SQL-count-and-limit path, even when a derived sort or an in-memory where would give the wrong page', file: 'runtime/store/query.mjs',
    find: "  if (later.length || sortField?.derive) {",
    replace: "  if (false) {" },
  { name: "round 7: hydrating a page never uses the batch cache — back to one query per row per aggregate (moved to store/hydrate.mjs in R8)", file: 'runtime/store/hydrate.mjs',
    find: "function hydratePageChunk(entity, rows) {\n  const cache = this.buildAggCache(entity, rows.map((r) => r.id));\n  return rows.map((r) => this.hydrate(entity, r, cache));\n}",
    replace: "function hydratePageChunk(entity, rows) { return rows.map((r) => this.hydrate(entity, r)); }" },
  { name: 'round 7: the prepared-statement cache never actually reuses a statement (recompiles every call)', file: 'runtime/store.mjs',
    find: "  prepare(sql) {\n    const hit = this.stmts.get(sql);\n    if (hit) { this.stmts.delete(sql); this.stmts.set(sql, hit); return hit; }\n    const st = this.db.prepare(sql);\n    this.stmts.set(sql, st);\n    if (this.stmts.size > 200) this.stmts.delete(this.stmts.keys().next().value);\n    return st;\n  }",
    replace: "  prepare(sql) { return this.db.prepare(sql); }" },

  // --- round 7, orchestrator review: item A/B/C fixes ---
  { name: 'round 7 item A: labelOf hydrates the whole target row again instead of reading only the label field', file: 'runtime/store/query.mjs',
    find: "  const v = f.derive ? this.derived(entity, row, f) : row[lf];",
    replace: "  const v = this.hydrate(entity, row)[lf];" },
  { name: 'round 7 item B: the IN-list is never chunked, so a big enough prefetch can exceed the bound-parameter limit', file: 'runtime/store/query.mjs',
    find: 'const IN_CHUNK = 5000;', replace: 'const IN_CHUNK = Infinity;' },
  { name: "round 7 item C: a batched child fetch drops the unbatched path's own order (ORDER BY id DESC), so a float sum can round differently", file: 'runtime/store/query.mjs',
    find: '`SELECT * FROM "${table}" WHERE "${via}" IN (${vals.map(() => \'?\').join(\',\')}) ORDER BY id DESC`',
    replace: '`SELECT * FROM "${table}" WHERE "${via}" IN (${vals.map(() => \'?\').join(\',\')})`' },

  // --- round 8: SQL-compiled aggregates (runtime/store/aggsql.mjs) and chunked hydration ---
  { name: 'R8 item 1: a fractional literal compiles too, reintroducing the float-summation-order risk the design avoids', file: 'runtime/store/aggexpr.mjs',
    find: "  if (n.t === 'num') return Number.isSafeInteger(n.v) ? int(String(n.v)) : null;",
    replace: "  if (n.t === 'num') return int(String(n.v));" },
  { name: 'R8 item 1: division compiles too (SQLite integer division truncates, and a per-row float would reopen the summation-order risk)', file: 'runtime/store/aggexpr.mjs',
    find: "  if (n.op !== '+' && n.op !== '-' && n.op !== '*') return null; // division and comparisons are never a value",
    replace: "  if (n.op === '=') return null;" },
  { name: 'R8 item 1: an ordering comparison with a null operand leaks SQL NULL instead of the definite false runtime/expr.mjs always returns', file: 'runtime/store/aggexpr.mjs',
    find: '  return `(CASE WHEN ${as} IS NULL OR ${bs} IS NULL THEN 0 ELSE (${as} ${n.op} ${bs}) END)`;',
    replace: '  return `(${as} ${n.op} ${bs})`;' },
  { name: 'R8 item 1: sum/count of an empty batched group comes back null instead of 0 (runtime/expr.mjs\'s own reduce(…, 0))', file: 'runtime/store/aggsql.mjs',
    find: "  const empty = compiled.fn === 'sum' || compiled.fn === 'count' ? 0 : null;",
    replace: '  const empty = null;' },
  { name: 'R8 item 1: a compiled sum is never converted out of its minor-unit scale', file: 'runtime/store/aggsql.mjs',
    find: "  if (c.fn === 'sum') return exact(Number(row.v ?? 0) / c.scale);",
    replace: "  if (c.fn === 'sum') return exact(Number(row.v ?? 0));" },
  { name: 'R8 item 1: a compiled avg is never converted out of its minor-unit scale', file: 'runtime/store/aggsql.mjs',
    find: "  if (c.fn === 'avg') { const n = Number(row.c ?? 0); return n ? exact(Number(row.v ?? 0) / c.scale / n) : null; }",
    replace: "  if (c.fn === 'avg') { const n = Number(row.c ?? 0); return n ? exact(Number(row.v ?? 0) / n) : null; }" },
  { name: 'R8 item 1: a single-row (uncached) compilable aggregate silently returns undefined instead of running its own query', file: 'runtime/store/hydrate.mjs',
    find: '  const hit = batch?.get(String(row.id));\n  return hit !== undefined ? hit : runAggOne(this, compiled, row.id, clock);',
    replace: '  return batch?.get(String(row.id));' },
  { name: 'R8 item 2: hydratePage no longer chunks a big page, so a full CSV export holds every batched child in memory for the whole request again', file: 'runtime/store/hydrate.mjs',
    find: '  if (rows.length <= HYDRATE_CHUNK) return hydratePageChunk.call(this, entity, rows);\n  const out = [];\n  for (let i = 0; i < rows.length; i += HYDRATE_CHUNK) out.push(...hydratePageChunk.call(this, entity, rows.slice(i, i + HYDRATE_CHUNK)));\n  return out;',
    replace: '  return hydratePageChunk.call(this, entity, rows);' },
  // --- round 9: derived fields, derived aggregates and dates in an aggregate body ---
  { name: 'R9 item 1: a money*money derived field is inlined without the cent rounding it would need', file: 'runtime/store/aggexpr.mjs',
    find: "  return s === 1 ? { sql: `(${v.sql} * 100)`, scale: 100 } : s === 100 ? clean : null;",
    replace: "  return s === 1 ? { sql: `(${v.sql} * 100)`, scale: 100 } : clean;" },
  { name: 'R9 item 1: an int derived from a money expression is inlined although Math.round of the major value is not the minor integer', file: 'runtime/store/aggexpr.mjs',
    find: "  if (f.kind === 'int') return s === 1 ? clean : null;", replace: "  if (f.kind === 'int') return clean;" },
  { name: 'R9 item 1: derived fields are inlined without any bound on how deep they nest', file: 'runtime/store/aggexpr.mjs',
    find: 'const MAX_STACK = 8;', replace: 'const MAX_STACK = Infinity;' },
  { name: 'R9 item 1: a derived-field expression that multiplies at every level may make the compiler exponential', file: 'runtime/store/aggexpr.mjs',
    find: 'export const MAX_EXPANSIONS = 200;', replace: 'export const MAX_EXPANSIONS = Infinity;' },
  { name: 'R9 item 2: subqueries nest without limit', file: 'runtime/store/aggexpr.mjs',
    find: 'const MAX_DEPTH = 5;', replace: 'const MAX_DEPTH = Infinity;' },
  { name: 'R9 item 2: the inner sum of an order with no items is NULL instead of 0 (evaluate()\'s reduce(…, 0))', file: 'runtime/store/aggexpr.mjs',
    find: "  if (n.fn === 'sum') return { sql: `COALESCE((SELECT SUM(${b.exprSQL}) ${from}), 0)`, scale: b.scale };",
    replace: "  if (n.fn === 'sum') return { sql: `(SELECT SUM(${b.exprSQL}) ${from})`, scale: b.scale };" },
  { name: 'R9 item 2: the correlated join compares a TEXT ref column with an INTEGER id, which cannot use the ref index (a scan per parent row)', file: 'runtime/store/aggexpr.mjs',
    find: '= CAST(t${cx.depth}."id" AS TEXT)`', replace: '= t${cx.depth}."id"`' },
  { name: 'R9 item 2: an inner avg (a fraction, evaluate() rounds it) compiles as a subquery', file: 'runtime/store/aggexpr.mjs',
    find: "  if (!b || n.fn === 'avg' || (n.fn === 'sum'", replace: "  if (!b || (n.fn === 'sum'" },
  { name: 'R9 item 2: a nested min/max over a raw money product (a double in JS) compiles, so its dust could meet a comparison', file: 'runtime/store/aggexpr.mjs',
    find: "(b.dusty && n.fn !== 'sum' && n.fn !== 'count')", replace: 'false' },
  { name: 'R9 item 2: a nested sum with more decimals than exact() keeps compiles', file: 'runtime/store/aggexpr.mjs',
    find: "(n.fn === 'sum' && b.scale > MAX_SCALE)", replace: 'false' },
  { name: 'R9 item 2: + and - accept operands beyond the 6 decimals exact() rounds to', file: 'runtime/store/aggexpr.mjs',
    find: '  return scale > MAX_SCALE ? null : {', replace: '  return false ? null : {' },
  { name: 'R9 item 3: a date compares with a number', file: 'runtime/store/aggexpr.mjs',
    find: 'const agree = (a, b) => (a.text ? !isNum(b) : b.text ? !isNum(a) : true);', replace: 'const agree = () => true;' },
  { name: 'R9 item 3: any string literal compiles, not only an ISO date/time', file: 'runtime/store/aggexpr.mjs',
    find: "DATE.test(n.v) || TIME.test(n.v) ? {", replace: "true ? {" },
  { name: 'R9 item 3: a sum over a date compiles', file: 'runtime/store/aggexpr.mjs',
    find: "(v.text && (node.fn === 'sum' || node.fn === 'avg'))", replace: 'false' },
  { name: 'R9 item 3: max/min over a date is answered as a number', file: 'runtime/store/aggsql.mjs',
    find: '  return c.text ? row.v : Number(row.v) / c.scale;', replace: '  return Number(row.v) / c.scale;' },
  { name: 'R9 item 3: `today` is bound with its time part (the clock as an ISO timestamp)', file: 'runtime/store/aggsql.mjs',
    find: "p === '$today' ? clock.toISOString().slice(0, 10) : clock.toISOString()", replace: 'clock.toISOString()' },
  { name: 'R9 item 3: a batch computed for one clock is read by an evaluation on another', file: 'runtime/store/hydrate.mjs',
    find: 'compiled.params.length && clock !== cache?.clock ? undefined :', replace: 'false ? undefined :' },
  { name: 'R9 item 3: an integer beyond SQLite/JS range throws out of a compiled aggregate instead of declining to the JS path', file: 'runtime/store/aggsql.mjs',
    find: '    if (OVERFLOW.test(String(e?.message))) return undefined;', replace: '    if (false) return undefined;' },
  { name: 'R9: a raw money product no longer counts as dusty (a nested min over it would compile)', file: 'runtime/store/aggexpr.mjs',
    find: '    const dusty = Boolean(a.dusty || b.dusty || (a.scale ?? 1) > 1 || (b.scale ?? 1) > 1);', replace: '    const dusty = false;' },
  // --- round 8: dashboard JSON money ---
  { name: "round 8: a dashboard JSON card/table/chart money aggregate answers raw minor units instead of major units", file: 'runtime/routes/views.mjs',
    find: "  return f?.kind === 'money' ? Number(formatMoney(Math.round(v))) : v;",
    replace: "  return v;" },
];

const TEST_TIMEOUT = 60_000; // a mutation that hangs a test must still terminate, and quickly: this is not the coverage run

// A mutated runtime can hang a test instead of failing it; a hang is a detection too — but
// `node --test` forks one worker process per test file, and killing only the `node --test`
// parent leaves those workers running forever (they do not share its process group by
// default). `detached: true` makes the parent the leader of its own group, so on timeout
// `process.kill(-pid, …)` reaches the parent and every worker it forked, not just the one pid.
const run = () => new Promise((resolve) => {
  const files = fs.readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/${f}`);
  const child = spawn('node', ['--no-warnings', '--test', ...files], { stdio: 'ignore', detached: true });
  let settled = false;
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, TEST_TIMEOUT);
  const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
  child.on('exit', (code) => finish(code === 0));
  child.on('error', () => finish(false));
});

if (!(await run())) { console.error('the suite is red before any mutation — fix that first'); process.exit(2); }

// An optional argument narrows the run to mutations whose name contains it.
const only = process.argv[2] || '';
let killed = 0;
const survivors = [];
const chosen = MUTATIONS.filter((m) => m.name.includes(only));
for (const m of chosen) {
  const original = fs.readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    console.log(`? ${m.name}\n    the mutation no longer applies to ${m.file} — update it`);
    survivors.push(m.name);
    continue;
  }
  // An interrupted run must not leave the mutation in the source tree.
  const restore = () => { fs.writeFileSync(m.file, original); process.exit(130); };
  process.once('SIGINT', restore).once('SIGTERM', restore);
  fs.writeFileSync(m.file, original.replace(m.find, m.replace));
  const started = Date.now();
  const green = await run();
  const ms = Date.now() - started;
  fs.writeFileSync(m.file, original);
  process.off('SIGINT', restore).off('SIGTERM', restore);
  // Close to TEST_TIMEOUT means the mutation hung a test rather than failing it —
  // still a kill (the process group is gone either way), but worth flagging.
  const slow = ms > TEST_TIMEOUT * 0.8 ? ` (${(ms / 1000).toFixed(1)}s — hung, not failed)` : '';
  if (green) { survivors.push(m.name); console.log(`✗ SURVIVED  ${m.name}${slow}`); }
  else { killed++; console.log(`✓ killed    ${m.name}${slow}`); }
}

console.log(`\n${killed}/${chosen.length} мутаций убито`);
if (survivors.length) {
  console.log('\nвыжили (значит, эти утверждения ничем не проверены):');
  for (const s of survivors) console.log(`  • ${s}`);
}
process.exit(survivors.length ? 1 : 0);
