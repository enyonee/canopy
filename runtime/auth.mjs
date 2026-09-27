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

// --- sessions: a signed cookie over a session row, the key lives next to the database -----------
// The cookie carries an opaque session id, never the user id: a token is revocable
// (logout deletes the row), does not survive a password change, and two logins of the
// same user are two different tokens.
export function sessions(keyFile, store = null) {
  let key;
  if (keyFile && fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, 'utf8').trim();
  else { key = crypto.randomBytes(24).toString('hex'); if (keyFile) fs.writeFileSync(keyFile, key); }
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest('hex');
  const sign = (sid) => { const body = String(sid); return `${body}.${mac(body)}`; };
  const verify = (token) => {
    if (!token) return null;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expect = mac(body);
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    return body;
  };
  // A cookie header is client input: a broken escape is a wrong cookie, never a crash.
  const token = (cookieHeader) => {
    const m = /(?:^|;\s*)ag_session=([^;]+)/.exec(cookieHeader || '');
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  };
  const start = (userId) => {
    const sid = crypto.randomBytes(16).toString('hex');
    store.sessionSet(sid, userId);
    return sign(sid);
  };
  const read = (cookieHeader) => {
    const sid = verify(token(cookieHeader));
    return sid ? store.sessionUser(sid) : null;
  };
  const end = (cookieHeader) => {
    const sid = verify(token(cookieHeader));
    if (sid) store.sessionEnd(sid);
  };
  const setCookie = (tok) => `ag_session=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax`;
  const clearCookie = () => 'ag_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  return { sign, verify, token, start, read, end, setCookie, clearCookie };
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
    // Does this row belong to the user, when the role is own-scoped? A "by"-gated
    // action still may not reach another user's row.
    ownOk(user, entity, row) {
      if (!spec || !row) return true;
      const e = entitySpec(roleOf(user), entity);
      if (!e?.own) return true;
      return user ? String(row[e.own]) === String(user.id) : false;
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
