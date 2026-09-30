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

// --- own: one or more paths, each a direct field or a one-hop "a.b" --------------
// "author" -> [["author"]]; ["sender","recipient"] -> [["sender"],["recipient"]];
// "profile.user" -> [["profile","user"]]. A row is owned if ANY path matches.
const parseOwnPaths = (spec) => {
  if (!spec) return null;
  const names = Array.isArray(spec) ? spec : [spec];
  return names.map((n) => String(n).split('.'));
};

// The parents a one-hop `own` path reads, loaded before any decision (`prime`, below): row object ->
// { ref field -> the row it points at, or null }. Keyed by the row object itself, so a fresh row is
// never judged on a stale parent and a row nobody primed is an error, not a query.
class Parents {
  constructor() { this.byRow = new WeakMap(); }

  put(row, field, parent) {
    if (!this.byRow.has(row)) this.byRow.set(row, new Map());
    this.byRow.get(row).set(field, parent);
  }

  of(entity, row, field) {
    const known = this.byRow.get(row);
    if (!known?.has(field)) throw new Error(`not primed: ${entity}.${field} (perms.prime(user, entity, rows) loads the parents an ownership check reads)`);
    return known.get(field);
  }
}

// Does `row` match this one path? Direct: compare the field to the user id.
// One-hop: the ref field's parent (primed), compare its subfield.
function matchesPath(parents, store, entity, row, path, userId) {
  if (path.length === 1) return String(row[path[0]]) === String(userId);
  if (!store) return false;
  const [refField, subField] = path;
  const f = store.field(entity, refField);
  const refId = row[refField];
  if (!f || refId === null || refId === undefined) return false;
  const parent = parents.of(entity, row, refField);
  return parent ? String(parent[subField]) === String(userId) : false;
}

// The load phase of matchesPath: the parents of `rows` along one one-hop path, in ONE query, whatever
// the number of rows. A blank or non-numeric reference points at nothing, like `store.raw` read it.
function primePath(parents, store, entity, rows, refField) {
  const f = store.field(entity, refField);
  if (!f) return;
  const todo = rows.filter((r) => !parents.byRow.get(r)?.has(refField));
  const keys = [...new Set(todo.map((r) => r[refField]).filter((v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v))).map((v) => String(Number(v))))];
  const found = new Map((keys.length ? store.listRawByIds(f.target, keys) : []).map((p) => [String(p.id), p]));
  for (const r of todo) {
    const v = r[refField];
    parents.put(r, refField, v === null || v === undefined || v === '' ? null : found.get(String(Number(v))) ?? null);
  }
}

// The row-set version of matchesPath, for list/dashboard/related scoping: the ids
// of `entity` owned by `userId` under one path, using only the public store API
// (store.list, which already knows "in") — no raw SQL here. A LOADER: it queries, so routes call it
// (through `ownWhere`) while they load a page, never while a view renders.
function idsForPath(store, entity, path, userId) {
  if (path.length === 1) return store.list(entity, { where: { [path[0]]: userId } }).map((r) => r.id);
  const [refField, subField] = path;
  const f = store.field(entity, refField);
  if (!f) return [];
  const parentIds = store.list(f.target, { where: { [subField]: userId } }).map((r) => r.id);
  if (!parentIds.length) return [];
  return store.list(entity, { where: { [refField]: { in: parentIds } } }).map((r) => r.id);
}

// --- the permission matrix --------------------------------------------------------
// /roles: { entity, login, password, role, register?, anonymous?, can: { <role>: "*" |
//   { <Entity>|"*": [ops] | { own, can: [ops], all?: [ops] } } } }
// ops: view, create, edit, delete, go:<transition>|go:*, do:<action>|do:*, "*"
// `own` scopes the ops in "can" to rows the viewer owns; ops in "all" are unscoped
// (they see/reach every row) even when "own" is declared — item 1's fix for the old
// all-or-nothing grant. `store` (the Store instance, threaded through every helper
// below) is optional: it is only ever dereferenced for a one-hop `own` path or a
// multi-path list-scoping query, so a plain single direct-field grant works without
// it (existing unit tests rely on this).
const opAllowed = (ops, op) => ops.includes('*') || ops.includes(op)
  || (op.includes(':') && ops.includes(`${op.split(':')[0]}:*`));

function entitySpecFor(spec, role, entity) {
  const r = spec.can?.[role];
  if (r === undefined) return null;
  if (r === '*') return { own: null, ops: ['*'], all: [] };
  const e = r[entity] ?? r['*'];
  if (e === undefined) return null;
  if (Array.isArray(e)) return { own: null, ops: e, all: [] };
  return { own: parseOwnPaths(e.own), ops: e.can || [], all: e.all || [] };
}

const ownedMatch = (parents, store, entity, row, paths, userId) => paths.some((p) => matchesPath(parents, store, entity, row, p, userId));

// May this user do `op` on `entity`, and on this particular row if one is given?
function canOp(spec, parents, store, roleOf, user, entity, op, row) {
  if (!spec) return true;
  const role = roleOf(user);
  if (!role) return false;
  const e = entitySpecFor(spec, role, entity);
  if (!e) return false;
  const unscoped = opAllowed(e.all, op);
  if (!unscoped && !opAllowed(e.ops, op)) return false;
  if (unscoped || !e.own || !row || op === 'create') return true;
  return user ? ownedMatch(parents, store, entity, row, e.own, user.id) : false;
}

// Does this row belong to the user, when the role is own-scoped? A "by"-gated
// action still may not reach another user's row — unless `op` names an unscoped
// ("all") operation, in which case "by" already settled it.
function ownOkFor(spec, parents, store, roleOf, user, entity, row, op) {
  if (!spec || !row) return true;
  const e = entitySpecFor(spec, roleOf(user), entity);
  if (!e?.own) return true;
  if (op && opAllowed(e.all, op)) return true;
  return user ? ownedMatch(parents, store, entity, row, e.own, user.id) : false;
}

// The single field a value may be silently filled into on create: the first own
// path, and only when it is a direct reference (never a one-hop, never the
// second-or-later field of a multi-field own).
function ownFieldFor(spec, roleOf, user, entity) {
  if (!spec) return null;
  const e = entitySpecFor(spec, roleOf(user), entity);
  const first = e?.own?.[0];
  return first && first.length === 1 ? first[0] : null;
}

// A where-fragment that narrows a list/dashboard/related read to owned rows — {}
// when the role has no own grant on this entity, or when `op` (default "view")
// is one of its unscoped "all" operations.
function ownWhereFor(spec, store, roleOf, user, entity, op) {
  if (!spec) return {};
  const e = entitySpecFor(spec, roleOf(user), entity);
  if (!e?.own || opAllowed(e.all, op)) return {};
  const userId = user ? user.id : -1;
  if (e.own.length === 1 && e.own[0].length === 1) return { [e.own[0][0]]: userId };
  if (!user) return { id: { in: [] } };
  const ids = new Set(e.own.flatMap((p) => idsForPath(store, entity, p, userId)));
  return { id: { in: [...ids] } };
}

export function permissions(graph, store = null) {
  const spec = graph.roles;
  const roleOf = (user) => (user ? String(user[spec.role]) : spec.anonymous || null);
  const parents = new Parents();
  return {
    enabled: Boolean(spec),
    roleOf,
    isAdmin: (user) => Boolean(spec) && spec.can?.[roleOf(user)] === '*',
    // Before `can`/`ownOk` judge rows of `entity` for `user`: the load phase of their ownership checks.
    // A one-hop `own` path reads the row's parent, so the parents of all `rows` are loaded here, in one
    // query per path; a row that was not primed makes the check throw `not primed`.
    prime(user, entity, rows) {
      if (!spec || !store) return;
      const e = entitySpecFor(spec, roleOf(user), entity);
      for (const p of e?.own || []) if (p.length === 2) primePath(parents, store, entity, rows, p[0]);
    },
    can: (user, entity, op, row = null) => canOp(spec, parents, store, roleOf, user, entity, op, row),
    ownOk: (user, entity, row, op = null) => ownOkFor(spec, parents, store, roleOf, user, entity, row, op),
    ownField: (user, entity) => ownFieldFor(spec, roleOf, user, entity),
    // The explicit loader of "which rows does this viewer own": queries when `own` is a one-hop or
    // multi-path grant, so a route calls it while loading and hands the result to the read it scopes.
    ownWhere: (user, entity, op = 'view') => ownWhereFor(spec, store, roleOf, user, entity, op),
    // Pages, lists and dashboards carry an optional "roles" list; absent means everyone.
    canSee(user, item) {
      if (!spec || !item.roles) return true;
      const role = roleOf(user);
      return Boolean(role) && item.roles.includes(role);
    },
  };
}
