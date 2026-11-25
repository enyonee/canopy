// The permission matrix of the graph (`roles.can`), judged in the browser only to decide what to offer:
// the same predicates the runtime's screens use (runtime/auth.mjs, render.mjs), so a button is shown where the
// server would allow the request. The server stays the authority; a refusal still arrives as a 403.
import { app } from '@/gen/app';
import type { Action, Entity, Grant, Transition } from '@/lib/model';
import type { Row } from '@/lib/api';

export type Viewer = { role: string | null; user: Row | null };

const opAllowed = (ops: readonly string[], op: string) =>
  ops.includes('*') || ops.includes(op) || (op.includes(':') && ops.includes(`${op.split(':')[0]}:*`));

function grantFor(role: string | null, entity: string): { ops: readonly string[]; own: readonly string[]; all: readonly string[] } | null {
  const roles = app.roles;
  if (!roles) return { ops: ['*'], own: [], all: [] };
  if (!role) return null;
  const r = roles.can[role];
  if (r === undefined) return null;
  if (r === '*') return { ops: ['*'], own: [], all: [] };
  const e: Grant | undefined = r[entity] ?? r['*'];
  if (e === undefined) return null;
  if (Array.isArray(e)) return { ops: e, own: [], all: [] };
  const g = e as Exclude<Grant, readonly string[]>;
  return { ops: g.can ?? [], own: g.own === undefined ? [] : ([] as string[]).concat(g.own as string | string[]), all: g.all ?? [] };
}

// Does this row belong to the viewer, along one `own` path ("customer" or "profile.user")? A one-hop path
// needs the parent row, which a JSON row does not carry: the server decides, so it counts as owned here.
function owns(viewer: Viewer, row: Row, paths: readonly string[]) {
  if (!viewer.user) return false;
  return paths.some((p) => (p.includes('.') ? true : String(row[p] ?? '') === String(viewer.user!.id)));
}

/** May the viewer do `op` on `entity` (and on `row`, when given)? */
export function can(viewer: Viewer, entity: string, op: string, row?: Row | null) {
  const g = grantFor(viewer.role, entity);
  if (!g) return false;
  const unscoped = opAllowed(g.all, op);
  if (!unscoped && !opAllowed(g.ops, op)) return false;
  if (unscoped || !g.own.length || !row || op === 'create') return true;
  return owns(viewer, row, g.own);
}

/** The field a create fills from the session (the first direct `own` path): never asked on the form. */
export function ownField(viewer: Viewer, entity: string) {
  const first = grantFor(viewer.role, entity)?.own[0];
  return first && !first.includes('.') ? first : null;
}

export const isAdmin = (viewer: Viewer) => !app.roles || (viewer.role !== null && app.roles.admins.includes(viewer.role));

/** Lists, dashboards and pages carry an optional `roles`; absent means everyone. */
export const canSee = (viewer: Viewer, roles: readonly string[] | null) => !app.roles || !roles || (viewer.role !== null && roles.includes(viewer.role));

export function mayRunAction(viewer: Viewer, entity: string, action: Action, row: Row) {
  if (action.by) {
    if (!viewer.role || !action.by.includes(viewer.role)) return false;
    const g = grantFor(viewer.role, entity);
    if (!g?.own.length || opAllowed(g.all, `do:${action.name}`)) return true;
    return owns(viewer, row, g.own);
  }
  return can(viewer, entity, `do:${action.name}`, row);
}

/** The transitions this row offers the viewer now: its status is in `from`, `by` names the role, the role may `go:`. */
export function transitionsFor(viewer: Viewer, entity: Entity, row: Row): Transition[] {
  const st = entity.states;
  if (!st) return [];
  return st.transitions.filter((t) => {
    if (t.from && !t.from.includes(String(row[st.field]))) return false;
    if (t.by && (!viewer.role || !t.by.includes(viewer.role))) return false;
    return can(viewer, entity.name, `go:${t.name}`, row);
  });
}

/** May the viewer read this field of this row (`detail.private`)? */
export function mayReadField(viewer: Viewer, entity: Entity, field: string, row: Row) {
  const who = entity.detail.private[field];
  if (!who) return true;
  return isAdmin(viewer) || (viewer.user !== null && String(row[who] ?? '') === String(viewer.user.id));
}
