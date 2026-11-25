// One client for the app's /api, typed by the OpenAPI document the runtime derives from the graph
// (src/gen/api.d.ts, openapi-typescript). Every answer is JSON; a refusal is `{ ok: false, status, errors }`,
// thrown here as an ApiError so a screen shows the server's own words.
import createClient from 'openapi-fetch';
import type { paths } from '@/gen/api';

export const client = createClient<paths>({ baseUrl: '', credentials: 'same-origin', headers: { accept: 'application/json' } });

export class ApiError extends Error {
  status: number;
  errors: string[];
  constructor(status: number, errors: string[]) {
    super(errors.join('; ') || `Request failed (${status})`);
    this.status = status;
    this.errors = errors;
  }
}

type Answer<T> = { data?: T; error?: unknown; response: Response };

/** The data of an answer, or the refusal it carries as an ApiError. */
export async function call<T>(pending: Promise<Answer<T>>): Promise<T> {
  let res: Answer<T>;
  try {
    res = await pending;
  } catch {
    throw new ApiError(0, ['The server cannot be reached. Check your connection and try again.']);
  }
  if (res.data !== undefined && res.response.ok) return res.data;
  const err = res.error as { errors?: unknown } | undefined;
  const errors = Array.isArray(err?.errors) ? err.errors.map(String) : [];
  throw new ApiError(res.response.status, errors.length ? errors : [statusText(res.response.status)]);
}

export function statusText(status: number) {
  if (status === 401) return 'Please sign in to continue.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'This record no longer exists.';
  if (status === 409) return 'This step is not available in the current state.';
  return `Something went wrong (${status}).`;
}

export type Row = { id: number } & Record<string, unknown>;
export type Page<R = Row> = { rows: R[]; total: number; page: number; pages: number };
export type Saved = { ok: true; id?: number; created?: number; flash: string; row?: Row };
export type Body = Record<string, string | number | boolean | null>;
export type Query = Record<string, string | number | undefined>;

/** What the screens call for an entity; src/gen/endpoints.ts binds each to its typed path. */
export interface EntityEndpoints {
  list(query: Query): Promise<Page>;
  get(id: number): Promise<Row>;
  create(body: Body): Promise<Saved>;
  update(id: number, body: Body): Promise<Saved>;
  remove(id: number): Promise<{ ok: true; flash: string }>;
  go: Record<string, (id: number, body: Body) => Promise<Saved>>;
  action: Record<string, (id: number, body: Body) => Promise<Saved>>;
  add: Record<string, (id: number, body: Body) => Promise<Saved>>;
  related: Record<string, (id: number, query: Query) => Promise<Page>>;
}

export type Dashboard = {
  cards: { title: string; value: number }[];
  tables: { title: string; rows: Record<string, unknown>[] }[];
  charts: { title: string; type: string; rows: { grp: unknown; v: number | null }[] }[];
};

export type Me = { user: Row | null; role: string | null };
export type Signed = { ok: true; flash: string; user: Row | null; role: string | null };

export interface AppEndpoints {
  entities: Record<string, EntityEndpoints>;
  lists: Record<string, (query: Query) => Promise<Page>>;
  dashboards: Record<string, (query: Query) => Promise<Dashboard>>;
  actions: Record<string, (body: Body) => Promise<{ ok: true; flash: string; created?: number }>>;
  me(): Promise<Me>;
  login(body: { login: string; password: string }): Promise<Signed>;
  logout(): Promise<Signed>;
  register(body: Body): Promise<Signed>;
}
