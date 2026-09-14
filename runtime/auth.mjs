// Roles, sessions and the permission matrix. Nothing here knows what a "lead"
// or an "order" is: the graph names the user entity, the role field and what
// each role may do; the runtime enforces it on every read and write.
import crypto from 'node:crypto';
import fs from 'node:fs';

// --- passwords -----------------------------------------------------------------
export const hashPassword = (plain) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(plain), salt, 32).toString('hex')}`;
};
export const isHashed = (v) => typeof v === 'string' && /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(v);
export const verifyPassword = (plain, stored) => {
  if (!isHashed(stored) || plain === undefined || plain === null) return false;
  const [, salt, hash] = stored.split('$');
  const probe = crypto.scryptSync(String(plain), salt, 32);
  const known = Buffer.from(hash, 'hex');
  return probe.length === known.length && crypto.timingSafeEqual(probe, known);
};

// --- sessions: a signed cookie, the key lives next to the database -----------------
export function sessions(keyFile) {
  let key;
  if (keyFile && fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, 'utf8').trim();
  else { key = crypto.randomBytes(24).toString('hex'); if (keyFile) fs.writeFileSync(keyFile, key); }
  const sign = (id) => { const body = String(id); return `${body}.${crypto.createHmac('sha256', key).update(body).digest('hex')}`; };
  const verify = (token) => {
    if (!token) return null;
    const [body, mac] = String(token).split('.');
    if (!body || !mac) return null;
    const expect = crypto.createHmac('sha256', key).update(body).digest('hex');
    if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    return Number(body);
  };
  const read = (cookieHeader) => {
    const m = /(?:^|;\s*)ag_session=([^;]+)/.exec(cookieHeader || '');
    return m ? verify(decodeURIComponent(m[1])) : null;
  };
  const setCookie = (id) => `ag_session=${encodeURIComponent(sign(id))}; Path=/; HttpOnly; SameSite=Lax`;
  const clearCookie = () => 'ag_session=; Path=/; HttpOnly; Max-Age=0';
  return { sign, verify, read, setCookie, clearCookie };
}

// --- the permission matrix --------------------------------------------------------
// /roles: { entity, login, password, role, register?, anonymous?, can: { <role>: "*" | { <Entity>|"*": [ops] | { own, can: [ops] } } } }
// ops: view, create, edit, delete, go:<transition>|go:*, do:<action>|do:*, "*"
export function permissions(graph) {
  const spec = graph.roles;
  const roleOf = (user) => (user ? String(user[spec.role]) : spec.anonymous || null);
  const entitySpec = (role, entity) => {
    const r = spec.can?.[role];
    if (r === undefined) return null;
    if (r === '*') return { own: null, ops: ['*'] };
    const e = r[entity] ?? r['*'];
    if (e === undefined) return null;
    if (Array.isArray(e)) return { own: null, ops: e };
    return { own: e.own || null, ops: e.can || [] };
  };
  const opAllowed = (ops, op) => ops.includes('*') || ops.includes(op)
    || (op.includes(':') && ops.includes(`${op.split(':')[0]}:*`));

  return {
    enabled: Boolean(spec),
    roleOf,
    isAdmin: (user) => Boolean(spec) && spec.can?.[roleOf(user)] === '*',
    // May this user do `op` on `entity`, and on this particular row if one is given?
    can(user, entity, op, row = null) {
      if (!spec) return true;
      const role = roleOf(user);
      if (!role) return false;
      const e = entitySpec(role, entity);
      if (!e || !opAllowed(e.ops, op)) return false;
      if (e.own && row && op !== 'create') return user ? String(row[e.own]) === String(user.id) : false;
      return true;
    },
    // The reference field that scopes this role to its own rows, if any.
    ownField(user, entity) {
      if (!spec) return null;
      const e = entitySpec(roleOf(user), entity);
      return e?.own || null;
    },
    // Pages, lists and dashboards carry an optional "roles" list; absent means everyone.
    canSee(user, item) {
      if (!spec || !item.roles) return true;
      const role = roleOf(user);
      return Boolean(role) && item.roles.includes(role);
    },
  };
}
