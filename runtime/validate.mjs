// The checker. Every error must name the path, the problem and the way out —
// the repair loop is where the tokens go, not the writing.
import { parseField, isStored, exprKind } from './spec.mjs';
import { parse as parseExpr, check as checkExpr, isExpression, stripExpression } from './expr.mjs';
import { DEFAULT } from './registry.mjs';

const near = (word, pool) => {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return pool.map((p) => [d(String(word).toLowerCase(), p.toLowerCase()), p]).sort((a, b) => a[0] - b[0])
    .filter(([n]) => n <= 3).slice(0, 3).map(([, p]) => p);
};

const VIEWS = ['list', 'form', 'detail'];
const FNS = ['count', 'sum', 'avg', 'min', 'max'];
const OPS = ['view', 'create', 'edit', 'delete', '*'];
const UNITS = ['day', 'month', 'year'];
const TOP = ['app', 'task', 'note', 'theme', 'home', 'data', 'seed', 'identity', 'roles', 'views', 'override', 'lists',
  'dashboards', 'pages', 'actions', 'events', 'states', 'connectors', 'rules', 'allowDestructive', 'plugins'];
const TRIGGERS = ['created', 'updated', 'deleted'];
const CTX_NAMES = ['me', 'now', 'today', 'created', 'delivery', 'values'];
const CMP = ['gte', 'lte', 'gt', 'lt', 'ne', 'in', 'like'];

export function validate(graph, registry = DEFAULT) {
  const CATALOG = registry.blocks;
  const errors = [];
  const err = (path, message, hint) => errors.push({ path, message, hint });

  if (!graph || typeof graph !== 'object') return [{ path: '/', message: 'graph must be an object' }];
  for (const k of Object.keys(graph)) {
    if (!TOP.includes(k)) {
      const n = near(k, TOP);
      err(`/${k}`, `unknown node "${k}"`, n.length ? `did you mean: ${n.join(', ')}?` : `nodes are: ${TOP.join(', ')}`);
    }
  }
  if (!graph.app) err('/app', 'missing application name');
  if (graph.plugins !== undefined && !Array.isArray(graph.plugins)) err('/plugins', 'plugins is a list of module paths', '["./plugins/loyalty.mjs"]');
  if (!graph.data || typeof graph.data !== 'object' || !Object.keys(graph.data).length) {
    err('/data', 'at least one entity is required', 'e.g. {"Task": {"title": "text!"}}');
    return errors;
  }

  const entities = Object.keys(graph.data);
  const fields = {};
  for (const [entity, spec] of Object.entries(graph.data)) {
    fields[entity] = {};
    for (const [name, raw] of Object.entries(spec)) {
      try {
        const f = parseField(name, raw, registry.fields, registry.functions);
        if (f.kind === 'ref' && !entities.includes(f.target))
          err(`/data/${entity}/${name}`, `reference to unknown entity "${f.target}"`, `known entities: ${entities.join(', ')}`);
        fields[entity][name] = f;
      } catch (e) { err(`/data/${entity}/${name}`, e.message); }
    }
  }
  const known = (e) => Object.keys(fields[e] || {});
  const checkEntity = (e, path) => {
    if (entities.includes(e)) return true;
    const n = near(e || '', entities);
    err(path, `unknown entity "${e}"`, n.length ? `did you mean: ${n.join(', ')}?` : `known entities: ${entities.join(', ')}`);
    return false;
  };
  const checkField = (e, f, path, { stored = false, secret = false } = {}) => {
    if (!known(e).includes(f)) {
      const n = near(f, known(e));
      err(path, `field "${f}" does not exist on ${e}`,
        n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${e}` : `known fields: ${known(e).join(', ')}`);
      return false;
    }
    if (stored && fields[e][f].derive) { err(path, `"${f}" is derived (:=) and cannot be written`, 'derived fields are computed on read'); return false; }
    if (secret && fields[e][f].type.secret) { err(path, `"${f}" is a ${fields[e][f].kind} and is never shown`, 'drop it from the columns'); return false; }
    return true;
  };

  // A where clause: { field: value } or { field: { gte, lte, gt, lt, ne, in, like } }.
  const checkWhere = (entity, where, path) => {
    for (const [f, cmp] of Object.entries(where || {})) {
      if (!checkField(entity, f, `${path}/${f}`)) continue;
      if (cmp && typeof cmp === 'object' && !Array.isArray(cmp))
        for (const op of Object.keys(cmp)) if (!CMP.includes(op)) err(`${path}/${f}/${op}`, `unknown comparison "${op}"`, `comparisons: ${CMP.join(', ')}`);
    }
  };

  // --- expressions -------------------------------------------------------------------
  const childVia = (child, parent, via) => {
    const refs = Object.values(fields[child] || {}).filter((f) => f.kind === 'ref' && f.target === parent);
    if (via) {
      const f = fields[child]?.[via];
      if (!f || f.kind !== 'ref' || f.target !== parent) throw new Error(`${child}.${via} is not a reference to ${parent}`);
      return via;
    }
    if (refs.length === 1) return refs[0].name;
    if (!refs.length) throw new Error(`${child} has no reference to ${parent}; add a "ref:${parent}" field to ${child}`);
    throw new Error(`${child} references ${parent} through ${refs.map((f) => f.name).join(' and ')}; name one: ${child}.${refs[0].name}`);
  };
  const fieldScope = (entity) => ({
    field(path) {
      const [head, ...rest] = path;
      const f = fields[entity]?.[head];
      if (!f) {
        const n = near(head, known(entity));
        throw new Error(`${entity} has no field "${head}"${n.length ? `; did you mean: ${n.join(', ')}?` : ''}`);
      }
      if (!rest.length) return exprKind(f);
      if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
      return fieldScope(f.target).field(rest);
    },
    children(child, via) {
      if (!entities.includes(child)) throw new Error(`unknown entity "${child}" in aggregate`);
      childVia(child, entity, via);
      return fieldScope(child);
    },
  });
  // Inside steps, names are the row and the values around it: row.x, each.x, found.x, values.x, me…
  const userEntity = graph.roles?.entity || graph.identity?.entity || null;
  const stepScope = (ctxEntities) => ({
    field(path) {
      const [head, ...rest] = path;
      if (head === 'me' && rest.length) {
        if (!userEntity) throw new Error('"me" has no fields here: declare /roles or /identity');
        return fieldScope(userEntity).field(rest);
      }
      if (['me', 'created', 'delivery'].includes(head)) return 'ref';
      if (head === 'values') return 'any';
      if (ctxEntities[head]) return rest.length ? fieldScope(ctxEntities[head]).field(rest) : 'ref';
      if (ctxEntities.row) return fieldScope(ctxEntities.row).field(path);
      throw new Error(`unknown name "${head}"; available here: ${[...Object.keys(ctxEntities), ...CTX_NAMES].join(', ')}`);
    },
    children(child, via) {
      if (!ctxEntities.row) throw new Error(`no current row here to aggregate ${child} against`);
      return fieldScope(ctxEntities.row).children(child, via);
    },
  });
  const checkExpression = (src, scope, path) => {
    try { return checkExpr(parseExpr(src, registry.functions), scope, registry.functions); }
    catch (e) { err(path, `bad expression: ${e.message}`, `expression: ${src}`); return null; }
  };
  const checkRefPath = (v, ctxEntities, path) => {
    const [head, ...rest] = v.slice(1).split('.');
    if (head === 'me' && rest.length) {
      if (!userEntity) return err(path, `"${v}" needs a user entity`, 'declare /roles or /identity, or use "@me"');
      try { fieldScope(userEntity).field(rest); } catch (e) { err(path, `bad reference "${v}": ${e.message}`); }
      return;
    }
    if (['me', 'now', 'today', 'created', 'delivery'].includes(head)) return;
    if (head === 'values') return;
    if (!ctxEntities[head]) {
      return err(path, `unknown reference "${v}"`, `available here: ${[...Object.keys(ctxEntities).map((k) => `@${k}.<field>`), '@me', '@created', '@now', '@today', '@values.<name>'].join(', ')}`);
    }
    if (rest.length && rest[0] !== 'id') {
      try { fieldScope(ctxEntities[head]).field(rest); } catch (e) { err(path, `bad reference "${v}": ${e.message}`); }
    }
  };
  // Every string inside a step's values may be "@path" or "= expr"; check both.
  const checkValues = (obj, ctxEntities, path) => {
    if (typeof obj === 'string') {
      if (obj.startsWith('@')) checkRefPath(obj, ctxEntities, path);
      else if (isExpression(obj)) checkExpression(stripExpression(obj), stepScope(ctxEntities), path);
      return;
    }
    if (Array.isArray(obj)) return obj.forEach((v, i) => checkValues(v, ctxEntities, `${path}/${i}`));
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) checkValues(v, ctxEntities, `${path}/${k}`);
  };

  // Derived fields: expressions type-check against their entity, and never form a cycle.
  const deps = {};
  for (const [entity, fs] of Object.entries(fields)) {
    for (const f of Object.values(fs)) {
      if (!f.derive) continue;
      const path = `/data/${entity}/${f.name}`;
      const kind = checkExpression(f.source, fieldScope(entity), path);
      if (kind && kind !== 'any' && exprKind(f) !== kind && !(f.kind === 'text' && kind === 'text'))
        err(path, `derived ${f.kind} field gets a ${kind} expression`, `declare it as "${kind === 'number' ? 'int' : kind} := …" or change the expression`);
      // Dependencies on other derived fields, through hops and aggregates.
      const out = new Set();
      const walk = (ast, e) => {
        const visit = (n) => {
          if (n.t === 'path') {
            let cur = e;
            for (const seg of n.p) {
              const g = fields[cur]?.[seg];
              if (!g) break;
              if (g.derive) out.add(`${cur}.${seg}`);
              if (g.kind === 'ref') cur = g.target; else break;
            }
          } else if (n.t === 'agg') { if (entities.includes(n.entity) && n.body) walk(n.body, n.entity); }
          else if (n.t === 'un') visit(n.a);
          else if (n.t === 'bin') { visit(n.a); visit(n.b); }
          else if (n.t === 'call') n.args.forEach(visit);
        };
        visit(ast);
      };
      walk(f.derive, entity);
      deps[`${entity}.${f.name}`] = [...out];
    }
  }
  const seen = {};
  const cycle = (key, stack) => {
    if (stack.includes(key)) return [...stack.slice(stack.indexOf(key)), key];
    if (seen[key]) return null;
    seen[key] = true;
    for (const d of deps[key] || []) { const c = cycle(d, [...stack, key]); if (c) return c; }
    return null;
  };
  for (const key of Object.keys(deps)) {
    const c = cycle(key, []);
    if (c) { err(`/data/${key.replace('.', '/')}`, `derived fields depend on each other: ${c.join(' → ')}`, 'one of them has to be stored'); break; }
  }

  if (graph.views !== undefined && graph.views !== 'auto')
    err('/views', 'only "auto" is supported', 'screens are derived from /data; shape them in /override');

  // --- identity / roles ------------------------------------------------------------------
  if (graph.identity) {
    if (checkEntity(graph.identity.entity, '/identity/entity'))
      for (const k of Object.keys(graph.identity.defaults || {})) checkField(graph.identity.entity, k, `/identity/defaults/${k}`);
  }
  const roles = graph.roles;
  let roleNames = [];
  if (roles) {
    if (graph.identity) err('/roles', 'roles and identity cannot both be declared', 'identity is the scaffold\'s single fake user; roles replace it');
    if (checkEntity(roles.entity, '/roles/entity')) {
      const need = (key, kinds) => {
        const name = roles[key];
        if (!name) return err(`/roles/${key}`, `roles need "${key}": the ${roles.entity} field used as ${key}`);
        if (checkField(roles.entity, name, `/roles/${key}`)) {
          const f = fields[roles.entity][name];
          const ok = key === 'password' ? f.type.secret : kinds.includes(f.kind);
          if (!ok) err(`/roles/${key}`, `"${name}" is ${f.kind}; ${key} must be ${key === 'password' ? 'a secret (password)' : kinds.join(' or ')}`);
          else if (key === 'role') roleNames = f.options;
        }
      };
      need('login', ['text']);
      need('password', ['password']);
      need('role', ['enum']);
      if (roles.register !== undefined && !roleNames.includes(roles.register))
        err('/roles/register', `"${roles.register}" is not a role`, `roles are the options of ${roles.entity}.${roles.role}: ${roleNames.join(', ')}`);
      if (roles.anonymous !== undefined) {
        if (roleNames.includes(roles.anonymous)) err('/roles/anonymous', `"${roles.anonymous}" is a signed-in role; the anonymous role needs its own name`, 'e.g. "guest"');
        else roleNames = [...roleNames, roles.anonymous];
      }
      if (!roles.can || typeof roles.can !== 'object') err('/roles/can', 'roles need "can": what each role may do', '{"admin": "*", "sales": {"Lead": ["view","create","edit"]}}');
    }
  }
  const stateNames = (e) => (graph.states?.[e]?.transitions || []).map((t) => t.name);
  const actionNames = (graph.actions || []).map((a) => a.name);
  const checkOp = (entity, op, path) => {
    if (typeof op !== 'string') return err(path, 'operation must be a string');
    if (OPS.includes(op)) return;
    const [kind, name] = op.split(':');
    if (kind === 'go' && (name === '*' || (entity === '*' ? true : stateNames(entity).includes(name)))) return;
    if (kind === 'do' && (name === '*' || (entity === '*' ? true : actionNames.includes(name)))) return;
    err(path, `unknown operation "${op}"`,
      `operations: ${OPS.join(', ')}, go:<transition>, do:<action>${entity !== '*' ? `; transitions of ${entity}: ${stateNames(entity).join(', ') || '(none)'}; actions: ${actionNames.join(', ') || '(none)'}` : ''}`);
  };
  if (roles?.can && typeof roles.can === 'object') {
    for (const [role, spec] of Object.entries(roles.can)) {
      const p = `/roles/can/${role}`;
      if (!roleNames.includes(role)) { err(p, `"${role}" is not a role`, `roles: ${roleNames.join(', ')}`); continue; }
      if (spec === '*') continue;
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { err(p, 'a role is "*" or an object of entity → operations'); continue; }
      for (const [entity, ops] of Object.entries(spec)) {
        const ep = `${p}/${entity}`;
        if (entity !== '*' && !checkEntity(entity, ep)) continue;
        const list = Array.isArray(ops) ? ops : ops?.can;
        if (!Array.isArray(list)) { err(ep, 'operations must be an array, or {"own": <ref field>, "can": [...]}'); continue; }
        list.forEach((op, i) => checkOp(entity, op, `${ep}/${Array.isArray(ops) ? i : `can/${i}`}`));
        if (!Array.isArray(ops) && ops.own) {
          if (entity === '*') err(`${ep}/own`, '"own" needs a concrete entity, not "*"');
          else if (checkField(entity, ops.own, `${ep}/own`)) {
            const f = fields[entity][ops.own];
            if (f.kind !== 'ref' || f.target !== roles.entity) err(`${ep}/own`, `"${ops.own}" must be a "ref:${roles.entity}" field of ${entity}`);
          }
        }
      }
    }
  }
  const checkRoles = (item, path) => {
    if (item.roles === undefined) return;
    if (!roles) return err(`${path}/roles`, 'no /roles declared, so nothing can be restricted by role');
    (item.roles || []).forEach((r, i) => { if (!roleNames.includes(r)) err(`${path}/roles/${i}`, `"${r}" is not a role`, `roles: ${roleNames.join(', ')}`); });
  };

  // --- steps (shared by actions, events, transitions) ----------------------------------------
  const checkSteps = (steps, path, entity, ctxIn = {}) => {
    const ctxEntities = { ...ctxIn };
    if (entity) ctxEntities.row = entity;
    (steps || []).forEach((step, j) => {
      const p = `${path}/${j}`;
      const block = CATALOG[step.block];
      if (!block) {
        const n = near(step.block || '', Object.keys(CATALOG));
        return err(`${p}/block`, `unknown block "${step.block}"`,
          n.length ? `did you mean: ${n.join(', ')}?` : `catalog: ${Object.keys(CATALOG).join(', ')}`);
      }
      for (const req of block.requires)
        if (step[req] === undefined) err(p, `block "${step.block}" requires "${req}"`, block.summary);
      if (step.entity !== undefined) checkEntity(step.entity, `${p}/entity`);
      if (step.from !== undefined) checkEntity(step.from, `${p}/from`);
      const target = step.entity || entity;
      if (step.field && target) checkField(target, step.field, `${p}/field`, { stored: true });
      if (step.via && step.entity) checkField(step.entity, step.via, `${p}/via`);
      if (step.set && entity) Object.keys(step.set).forEach((f) => checkField(entity, f, `${p}/set/${f}`, { stored: true }));
      if (step.values && step.entity) Object.keys(step.values).forEach((f) => checkField(step.entity, f, `${p}/values/${f}`, { stored: true }));
      if (step.where && step.entity) checkWhere(step.entity, step.where, `${p}/where`);
      if (step.where && step.block === 'db.each' && step.from) checkWhere(step.from, step.where, `${p}/where`);
      if (step.into && entity) checkField(entity, step.into, `${p}/into`, { stored: true });
      if (block.connector) {
        const c = graph.connectors?.[step.connector];
        if (!c) err(`${p}/connector`, `unknown connector "${step.connector}"`, `declared: ${Object.keys(graph.connectors || {}).join(', ') || '(none; add /connectors)'}`);
        else if (c.kind !== block.connector) err(`${p}/connector`, `connector "${step.connector}" is ${c.kind}, ${step.block} needs ${block.connector}`);
      }
      if (block.check) block.check(step, { err, fields, entity, graph, path: p, checkEntity, checkField });
      for (const key of ['set', 'values', 'where', 'body', 'id', 'by', 'to', 'path'])
        if (step[key] !== undefined) checkValues(step[key], ctxEntities, `${p}/${key}`);
      for (const sub of block.nested ? block.nested(step) : []) checkSteps(sub.steps, `${p}/${sub.path}`, entity, { ...ctxEntities, ...sub.adds });
      if (block.exposes) Object.assign(ctxEntities, block.exposes(step));
    });
  };

  // --- override, lists, dashboards, pages, seed ---------------------------------------------
  for (const [key, ov] of Object.entries(graph.override || {})) {
    const [entity, kind] = key.split('.');
    if (!checkEntity(entity, `/override/${key}`)) continue;
    if (!VIEWS.includes(kind)) { err(`/override/${key}`, `unknown view "${kind}"`, `views are: ${VIEWS.join(', ')}`); continue; }
    (ov.columns || []).forEach((f) => f === 'id' || checkField(entity, f, `/override/${key}/columns`, { secret: true }));
    (ov.search || []).forEach((f) => checkField(entity, f, `/override/${key}/search`, { stored: true }));
    (ov.fields || []).forEach((f) => checkField(entity, f, `/override/${key}/fields`, { stored: kind === 'form', secret: kind === 'detail' }));
    (ov.actions || []).forEach((a, i) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/override/${key}/actions/${i}`, `unknown action "${a}"`, `declared in /actions: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in !== entity) err(`/override/${key}/actions/${i}`, `action "${a}" is not bound to ${entity}`, `it needs "in": "${entity}"`);
    });
    if (ov.sort) checkField(entity, ov.sort.field, `/override/${key}/sort/field`);
    Object.keys(ov.fill || {}).forEach((f) => checkField(entity, f, `/override/${key}/fill/${f}`, { stored: true }));
    checkWhere(entity, ov.where, `/override/${key}/where`);
    Object.keys(ov.labels || {}).forEach((f) => checkField(entity, f, `/override/${key}/labels/${f}`));
    (ov.filters || []).forEach((flt, i) => {
      if (!flt.field) return err(`/override/${key}/filters/${i}`, 'filter needs a "field"');
      if (!checkField(entity, flt.field, `/override/${key}/filters/${i}/field`)) return;
      const f = fields[entity][flt.field];
      if (flt.range) {
        if (!f.type.numeric && !f.type.temporal) err(`/override/${key}/filters/${i}`, `a range filter needs a date, time, int or money field; "${flt.field}" is ${f.kind}`);
        return;
      }
      if (!flt.options && !['ref', 'enum', 'bool'].includes(f.kind))
        err(`/override/${key}/filters/${i}`, `filter on "${flt.field}" needs "options"`,
          'options are derived automatically only for ref, enum and bool fields');
    });
    (ov.rowActions || []).forEach((a, i) => {
      if (['edit', 'delete', 'view'].includes(a)) return;
      if (typeof a === 'string' && a.startsWith('go:')) {
        if (!stateNames(entity).includes(a.slice(3)))
          err(`/override/${key}/rowActions/${i}`, `unknown transition "${a.slice(3)}" on ${entity}`, `declared in /states/${entity}: ${stateNames(entity).join(', ') || '(none)'}`);
        return;
      }
      if (!actionNames.includes(a))
        err(`/override/${key}/rowActions/${i}`, `unknown action "${a}"`,
          `built-in: view, edit, delete, go:<transition>; declared in /actions: ${actionNames.join(', ') || '(none)'}`);
    });
    (ov.related || []).forEach((rel, i) => {
      const p = `/override/${key}/related/${i}`;
      if (!checkEntity(rel.entity, `${p}/entity`)) return;
      if (!rel.via) return err(`${p}/via`, 'related section needs "via" (the ref field on the child)');
      if (checkField(rel.entity, rel.via, `${p}/via`)) {
        const f = fields[rel.entity][rel.via];
        if (f.kind !== 'ref') err(`${p}/via`, `"${rel.via}" is ${f.kind}, not a reference`, `declare it as "ref:${entity}"`);
        else if (f.target !== entity) err(`${p}/via`, `"${rel.via}" points at ${f.target}, not ${entity}`);
      }
      (rel.columns || []).forEach((c) => c === 'id' || checkField(rel.entity, c, `${p}/columns`, { secret: true }));
      (rel.rowActions || []).forEach((a, k) => {
        if (['edit', 'delete', 'view'].includes(a) || (typeof a === 'string' && a.startsWith('go:') && stateNames(rel.entity).includes(a.slice(3)))) return;
        if (!(graph.actions || []).some((x) => x.name === a && x.in === rel.entity)) err(`${p}/rowActions/${k}`, `unknown action "${a}" on ${rel.entity}`, 'built-in: view, edit, delete, go:<transition>, or an action with "in" set to this entity');
      });
      Object.keys(rel.fill || {}).forEach((c) => checkField(rel.entity, c, `${p}/fill/${c}`, { stored: true }));
    });
  }

  (graph.lists || []).forEach((l, i) => {
    const p = `/lists/${i}`;
    if (!l.id) err(`${p}/id`, 'list needs an id (it becomes /list/<id>)');
    checkRoles(l, p);
    if (!checkEntity(l.entity, `${p}/entity`)) return;
    (l.columns || []).forEach((c) => c === 'id' || checkField(l.entity, c, `${p}/columns`, { secret: true }));
    checkWhere(l.entity, l.where, `${p}/where`);
    if (l.sort) checkField(l.entity, l.sort.field, `${p}/sort/field`);
  });

  (graph.dashboards || []).forEach((d, i) => {
    const p = `/dashboards/${i}`;
    if (!d.id) err(`${p}/id`, 'dashboard needs an id (it becomes /dashboard/<id>)');
    checkRoles(d, p);
    for (const [e, f] of Object.entries(d.period || {})) {
      if (!checkEntity(e, `${p}/period/${e}`)) continue;
      if (checkField(e, f, `${p}/period/${e}`) && !fields[e][f].type.temporal)
        err(`${p}/period/${e}`, `period field "${f}" must be a date or time; it is ${fields[e][f].kind}`);
    }
    (d.cards || []).forEach((c, j) => {
      const cp = `${p}/cards/${j}`;
      if (!checkEntity(c.entity, `${cp}/entity`)) return;
      if (c.fn && !FNS.includes(c.fn)) err(`${cp}/fn`, `unknown function "${c.fn}"`, `known: ${FNS.join(', ')}`);
      if (c.fn && c.fn !== 'count' && !c.field) err(`${cp}/field`, `"${c.fn}" needs a field`);
      if (c.field) checkField(c.entity, c.field, `${cp}/field`);
      checkWhere(c.entity, c.where, `${cp}/where`);
    });
    (d.tables || []).forEach((t, j) => {
      const tp = `${p}/tables/${j}`;
      if (!checkEntity(t.entity, `${tp}/entity`)) return;
      if (t.groupBy) checkField(t.entity, t.groupBy, `${tp}/groupBy`);
      if (t.groupUnit) {
        if (!UNITS.includes(t.groupUnit)) err(`${tp}/groupUnit`, `unknown unit "${t.groupUnit}"`, `units: ${UNITS.join(', ')}`);
        const g = t.groupBy && fields[t.entity]?.[t.groupBy];
        if (g && !g.type.temporal) err(`${tp}/groupUnit`, `groupUnit needs a date or time groupBy; "${t.groupBy}" is ${g.kind}`);
      }
      checkWhere(t.entity, t.where, `${tp}/where`);
      (t.metrics ?? []).forEach((m, k) => {
        if (!m.as) err(`${tp}/metrics/${k}/as`, 'metric needs a name in "as"');
        if (!FNS.includes(m.fn)) err(`${tp}/metrics/${k}/fn`, `unknown function "${m.fn}"`, `known: ${FNS.join(', ')}`);
        if (m.fn !== 'count') checkField(t.entity, m.field, `${tp}/metrics/${k}/field`);
      });
      if (t.sort && !(t.metrics ?? []).some((m) => m.as === t.sort.field) && t.sort.field !== 'grp')
        err(`${tp}/sort/field`, `sort must name a metric or "grp"`,
          `metrics here: ${(t.metrics || []).map((m) => m.as).join(', ')}`);
    });
  });

  (graph.pages || []).forEach((p, i) => {
    if (!p.id) err(`/pages/${i}/id`, 'page needs an id (it becomes /page/<id>)');
    if (!p.title) err(`/pages/${i}/title`, 'page needs a title (it is the menu label)');
    checkRoles(p, `/pages/${i}`);
    (p.actions || []).forEach((a, j) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/pages/${i}/actions/${j}`, `unknown action "${a}"`, `declared: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in) err(`/pages/${i}/actions/${j}`, `action "${a}" is bound to ${act.in}`, 'page buttons need a global action (no "in")');
    });
  });

  for (const [entity, rows] of Object.entries(graph.seed || {})) {
    if (!checkEntity(entity, `/seed/${entity}`)) continue;
    (rows || []).forEach((row, i) =>
      Object.keys(row).forEach((f) => checkField(entity, f, `/seed/${entity}/${i}/${f}`, { stored: true })));
  }

  // --- actions, events, states, connectors, rules ----------------------------------------------
  (graph.actions || []).forEach((a, i) => {
    if (!a.name) err(`/actions/${i}/name`, 'action needs a name');
    if (a.in !== undefined && a.in !== null) checkEntity(a.in, `/actions/${i}/in`);
    if (!Array.isArray(a.do) || !a.do.length) err(`/actions/${i}/do`, 'action needs at least one step');
    checkSteps(a.do, `/actions/${i}/do`, a.in);
  });

  (graph.events || []).forEach((ev, i) => {
    const p = `/events/${i}`;
    const m = /^(\w+)\.(\w+)$/.exec(ev.on || '');
    if (!m || !TRIGGERS.includes(m[2])) err(`${p}/on`, `unsupported trigger "${ev.on}"`, `triggers: <Entity>.${TRIGGERS.join(', <Entity>.')}`);
    else checkEntity(m[1], `${p}/on`);
    checkSteps(ev.do, `${p}/do`, m && entities.includes(m[1]) ? m[1] : null);
  });

  for (const [entity, st] of Object.entries(graph.states || {})) {
    const p = `/states/${entity}`;
    if (!checkEntity(entity, p)) continue;
    if (!st.field) { err(`${p}/field`, 'states need "field": the enum field that holds the status'); continue; }
    if (!checkField(entity, st.field, `${p}/field`)) continue;
    const f = fields[entity][st.field];
    if (f.kind !== 'enum') { err(`${p}/field`, `"${st.field}" is ${f.kind}; a status field must be an enum with a default`); continue; }
    if (f.def === null) { err(`${p}/field`, `"${st.field}" needs a default: it is the initial status`, `e.g. "enum[${f.options.join(',')}]=${f.options[0]}"`); continue; }
    const names = new Set();
    const reach = new Set([f.def]);
    (st.transitions || []).forEach((t, i) => {
      const tp = `${p}/transitions/${i}`;
      if (!t.name) err(`${tp}/name`, 'transition needs a name (it becomes the button and the go:<name> operation)');
      else if (names.has(t.name)) err(`${tp}/name`, `transition "${t.name}" is declared twice`);
      names.add(t.name);
      if (!f.options.includes(t.to)) err(`${tp}/to`, `"${t.to}" is not a status of ${entity}`, `statuses: ${f.options.join(', ')}`);
      const from = t.from === undefined || t.from === '*' ? f.options : Array.isArray(t.from) ? t.from : [t.from];
      from.forEach((s, k) => { if (!f.options.includes(s)) err(`${tp}/from/${k}`, `"${s}" is not a status of ${entity}`, `statuses: ${f.options.join(', ')}`); });
      if (t.by !== undefined) {
        if (!roles) err(`${tp}/by`, 'no /roles declared, so "by" cannot restrict who may transition');
        else (t.by || []).forEach((r, k) => { if (!roleNames.includes(r)) err(`${tp}/by/${k}`, `"${r}" is not a role`, `roles: ${roleNames.join(', ')}`); });
      }
      (t.fields || []).forEach((x) => checkField(entity, x, `${tp}/fields`, { stored: true }));
      checkSteps(t.do, `${tp}/do`, entity);
    });
    // Every status must be reachable from the initial one, or it is dead weight in the enum.
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of st.transitions || []) {
        const from = t.from === undefined || t.from === '*' ? f.options : Array.isArray(t.from) ? t.from : [t.from];
        if (from.some((s) => reach.has(s)) && !reach.has(t.to)) { reach.add(t.to); grew = true; }
      }
    }
    const dead = f.options.filter((o) => !reach.has(o));
    if (dead.length) err(`${p}/transitions`, `no transition leads to: ${dead.join(', ')}`, `add a transition "to" each, or drop it from ${entity}.${st.field}`);
  }

  for (const [name, c] of Object.entries(graph.connectors || {})) {
    const p = `/connectors/${name}`;
    if (!c || typeof c !== 'object') { err(p, 'connector must be an object'); continue; }
    const transport = registry.transports[c.kind];
    if (!transport) { err(`${p}/kind`, `unknown connector kind "${c.kind}"`, `kinds: ${Object.keys(registry.transports).join(', ')}`); continue; }
    for (const [key, message, hint] of transport.validate(c)) err(`${p}/${key}`, message, hint);
  }

  for (const [entity, list] of Object.entries(graph.rules || {})) {
    const p = `/rules/${entity}`;
    if (!checkEntity(entity, p)) continue;
    if (!Array.isArray(list)) { err(p, 'rules must be an array', '[{"check": "qty > 0", "message": "…"}, {"unique": "email"}]'); continue; }
    list.forEach((r, i) => {
      const rp = `${p}/${i}`;
      if (r.unique !== undefined) return checkField(entity, r.unique, `${rp}/unique`, { stored: true });
      if (r.check === undefined) return err(rp, 'a rule is {"check": <expression>, "message": …} or {"unique": <field>}');
      const kind = checkExpression(r.check, fieldScope(entity), `${rp}/check`);
      if (kind && kind !== 'bool' && kind !== 'any') err(`${rp}/check`, `a check must be a condition; this expression is ${kind}`);
      if (!r.message) err(`${rp}/message`, 'a check needs a "message" the user sees when it fails');
    });
  }

  return errors;
}

export const formatErrors = (errors) =>
  errors.map((e) => `  ✗ ${e.path}: ${e.message}${e.hint ? `\n      → ${e.hint}` : ''}`).join('\n');

export { isStored };
