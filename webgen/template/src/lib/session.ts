// Who is signed in: GET /api/me, cached for the whole app and refreshed after every sign-in or sign-out.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/gen/endpoints';
import type { Me } from '@/lib/api';
import type { Viewer } from '@/lib/perms';
import { app } from '@/gen/app';

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: () => endpoints.me(), staleTime: 60_000 });
}

/** The viewer the permission predicates judge: while /api/me loads, an anonymous one. */
export function useViewer(): Viewer & { loading: boolean } {
  const me = useMe();
  const data: Me | undefined = me.data;
  return { role: data?.role ?? app.roles?.anonymous ?? null, user: data?.user ?? null, loading: me.isPending };
}

/** After the session changed: everything cached was read as somebody else. */
export function useSessionChanged() {
  const qc = useQueryClient();
  return async (me: Me) => {
    qc.clear();
    qc.setQueryData(meKey, me);
  };
}

/** How the signed-in user is named: the label field of the roles entity, else the login. */
export function userName(user: Me['user']) {
  if (!user || !app.roles) return '';
  const e = app.entities[app.roles.entity];
  const name = (e.fields.find((f) => f.name === 'name' && f.kind === 'text')?.name) ?? e.labelField ?? app.roles.login;
  return String(user[name] ?? user[app.roles.login] ?? `#${user.id}`);
}
