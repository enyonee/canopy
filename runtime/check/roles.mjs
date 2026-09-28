// Identity (the scaffold's one fake user) and roles (real login, sessions,
// and the permission matrix). Sets h.roles/h.roleNames/h.checkRoles/
// h.stateNames/h.actionNames for every checker that runs after this one —
// lists, dashboards, pages, override and states all restrict by role.
const OPS = ['view', 'create', 'edit', 'delete', '*'];

export const NODES = ['identity', 'roles'];

function checkIdentity(graph, h) {
  if (!graph.identity) return;
  if (h.checkEntity(graph.identity.entity, '/identity/entity'))
    for (const k of Object.keys(graph.identity.defaults || {})) h.checkField(graph.identity.entity, k, `/identity/defaults/${k}`);
}

// Validates roles.entity/login/password/role and returns the option list of
// the role field (empty if roles is absent or its own fields are invalid).
function checkRoleFields(graph, h) {
  const { err, checkEntity, checkField, fields } = h;
  const roles = graph.roles;
  let roleNames = [];
  if (!roles) return roleNames;
  if (graph.identity) err('/roles', 'roles and identity cannot both be declared', 'identity is the scaffold\'s single fake user; roles replace it');
  if (!checkEntity(roles.entity, '/roles/entity')) return roleNames;

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
  return roleNames;
}

// One "own" path: a direct field ("author") or a one-hop "a.b" (the entity's own
// ref field "a", then a ref-to-the-user-entity field "b" on whatever "a" targets).
function checkOwnPath(roles, entity, raw, path, h) {
  const { err, checkField, fields } = h;
  const segs = String(raw).split('.');
  if (segs.length > 2) return err(path, `"${raw}" has more than one hop`, 'an own path is a direct field ("author") or one hop ("profile.user")');
  if (segs.length === 1) {
    if (checkField(entity, segs[0], path)) {
      const f = fields[entity][segs[0]];
      if (f.kind !== 'ref' || f.target !== roles.entity) err(path, `"${segs[0]}" must be a "ref:${roles.entity}" field of ${entity}`);
    }
    return;
  }
  const [a, b] = segs;
  if (!checkField(entity, a, path)) return;
  const fa = fields[entity][a];
  if (fa.kind !== 'ref') return err(path, `"${a}" is ${fa.kind}, not a reference`, `a one-hop own path needs "${a}" to be a "ref:<Entity>" field`);
  if (checkField(fa.target, b, path)) {
    const fb = fields[fa.target][b];
    if (fb.kind !== 'ref' || fb.target !== roles.entity) err(path, `"${a}.${b}" must end in a "ref:${roles.entity}" field of ${fa.target}`);
  }
}

function checkOwnGrant(roles, entity, ep, ops, h) {
  if (entity === '*') return h.err(`${ep}/own`, '"own" needs a concrete entity, not "*"');
  const names = Array.isArray(ops.own) ? ops.own : [ops.own];
  if (!names.length) return h.err(`${ep}/own`, '"own" needs at least one field');
  names.forEach((raw, i) => checkOwnPath(roles, entity, raw, `${ep}/own${Array.isArray(ops.own) ? `/${i}` : ''}`, h));
}

function checkCanMatrix(graph, h, roleNames, checkOp) {
  const { err, checkEntity } = h;
  const roles = graph.roles;
  if (!roles?.can || typeof roles.can !== 'object') return;
  for (const [role, spec] of Object.entries(roles.can)) {
    const p = `/roles/can/${role}`;
    if (!roleNames.includes(role)) { err(p, `"${role}" is not a role`, `roles: ${roleNames.join(', ')}`); continue; }
    if (spec === '*') continue;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { err(p, 'a role is "*" or an object of entity → operations'); continue; }
    for (const [entity, ops] of Object.entries(spec)) {
      const ep = `${p}/${entity}`;
      if (entity !== '*' && !checkEntity(entity, ep)) continue;
      const list = Array.isArray(ops) ? ops : ops?.can;
      if (!Array.isArray(list)) { err(ep, 'operations must be an array, or {"own": <field>, "can": [...], "all"?: [...]}'); continue; }
      list.forEach((op, i) => checkOp(entity, op, `${ep}/${Array.isArray(ops) ? i : `can/${i}`}`));
      if (Array.isArray(ops)) continue;
      (ops.all || []).forEach((op, i) => checkOp(entity, op, `${ep}/all/${i}`));
      if (ops.own) checkOwnGrant(roles, entity, ep, ops, h);
    }
  }
}

export function check(graph, h) {
  const { err } = h;
  checkIdentity(graph, h);
  const roleNames = checkRoleFields(graph, h);

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
  checkCanMatrix(graph, h, roleNames, checkOp);

  h.roles = graph.roles;
  h.roleNames = roleNames;
  h.stateNames = stateNames;
  h.actionNames = actionNames;
  h.checkRoles = (item, path) => {
    if (item.roles === undefined) return;
    if (!graph.roles) return err(`${path}/roles`, 'no /roles declared, so nothing can be restricted by role');
    (item.roles || []).forEach((r, i) => { if (!roleNames.includes(r)) err(`${path}/roles/${i}`, `"${r}" is not a role`, `roles: ${roleNames.join(', ')}`); });
  };
}
