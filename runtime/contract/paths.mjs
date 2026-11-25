// The operations of the OpenAPI contract (runtime/contract.mjs): one per route /api serves, named from the graph.
// Pure over the graph and its parsed fields. Who may call an operation is not here: the routes decide that per request
// (roles, `own`, `by`), and the contract says only that any call may be refused (403).
import { ref, ERROR, writableFields, inputSchema, textInput } from './schemas.mjs';

const json = (schema) => ({ content: { 'application/json': { schema } } });
const REFUSALS = { 400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 413: 'TooLarge', 415: 'UnsupportedMediaType' };
// What every POST can answer before its route runs: a body that is not a JSON object, another site, too large, not JSON.
const POST_CODES = [400, 403, 413, 415];

/** The shared error answers, one per status the routes use. */
export function refusalResponses() {
  return Object.fromEntries(Object.values(REFUSALS).map((name) => [name, { description: name.replace(/(?!^)([A-Z])/g, ' $1'), ...json(ref(ERROR)) }]));
}

function answers(okRef, codes) {
  const out = { 200: { description: 'OK', ...json(ref(okRef)) } };
  for (const c of [...new Set(codes)].sort()) out[c] = { $ref: `#/components/responses/${REFUSALS[c]}` };
  return out;
}

const query = (name, schema = { type: 'string' }) => ({ name, in: 'query', required: false, schema });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };

const get = (operationId, tag, okRef, codes, parameters) => ({ get: { operationId, tags: [tag], ...(parameters?.length ? { parameters } : {}), responses: answers(okRef, [403, ...codes]) } });
const post = (operationId, tag, okRef, codes, body, parameters) => ({ post: { operationId, tags: [tag], ...(parameters?.length ? { parameters } : {}),
  requestBody: { required: true, ...json(body) }, responses: answers(okRef, [...POST_CODES, ...codes]) } });

// ?q=, ?page=, ?sort=&dir= on every list; an entity's own list also takes its declared filters.
function listParams(fields, ov, { filters = true } = {}) {
  const ps = [];
  if (ov.search?.length) ps.push(query('q'));
  ps.push(query('page', { type: 'integer', minimum: 1 }), query('sort', { type: 'string', enum: ['id', ...fields.map((f) => f.name)] }), query('dir', { type: 'string', enum: ['asc', 'desc'] }));
  for (const f of filters ? ov.filters || [] : []) {
    if (f.range) ps.push(query(`${f.field}_from`), query(`${f.field}_to`));
    else ps.push(query(f.field));
  }
  return ps;
}

const pick = (fields, names = []) => names.map((n) => fields.find((f) => f.name === n)).filter(Boolean);

// The routes of one entity: list, create, read, edit, delete, its transitions, row actions and related adds.
function entityPaths(graph, fields, entity) {
  const own = fields[entity], ov = graph.override?.[`${entity}.list`] || {};
  const st = graph.states?.[entity];
  const body = ref(`${entity}.input`);
  const at = `/api/${entity}/{id}`;
  /** @type {Record<string, any>} */
  const paths = {
    [`/api/${entity}`]: { ...get(`list${entity}`, entity, `${entity}.page`, [], listParams(own, ov)), ...post(`create${entity}`, entity, `${entity}.saved`, [], body) },
    [at]: { ...get(`get${entity}`, entity, entity, [404], [idParam]), ...post(`update${entity}`, entity, `${entity}.saved`, [404], body, [idParam]) },
    [`${at}/delete`]: post(`delete${entity}`, entity, 'canopy.Deleted', [404], { type: 'object' }, [idParam]),
  };
  for (const t of st?.transitions || []) {
    const ask = pick(own, t.fields);
    paths[`${at}/go/${t.name}`] = post(`${entity}_go_${t.name}`, entity, `${entity}.saved`, [404, 409], inputSchema(ask, { required: t.fields || [], open: true }), [idParam]);
  }
  for (const a of (graph.actions || []).filter((x) => x.in === entity)) {
    paths[`${at}/action/${a.name}`] = post(`${entity}_action_${a.name}`, entity, `${entity}.saved`, [404], inputSchema(pick(own, a.fields), { required: a.fields || [], open: true }), [idParam]);
  }
  for (const rel of graph.override?.[`${entity}.detail`]?.related || []) {
    const kid = fields[rel.entity];
    const body = inputSchema(writableFields(kid, { only: Array.isArray(rel.form) ? rel.form : null, skip: [rel.via, ...Object.keys(rel.fill || {}), graph.states?.[rel.entity]?.field] }));
    paths[`${at}/add/${rel.entity}`] = post(`${entity}_add_${rel.entity}`, entity, `${rel.entity}.saved`, [404], body, [idParam]);
    paths[`${at}/related/${rel.entity}`] = get(`${entity}_related_${rel.entity}`, entity, `${rel.entity}.page`, [404], [idParam, query('page', { type: 'integer', minimum: 1 })]);
  }
  return paths;
}

// Sign-in, registration, sign-out and "who am I".
function sessionPaths(graph) {
  const r = graph.roles;
  const paths = { '/api/me': get('me', 'session', 'canopy.Me', []) };
  if (!r) return paths;
  paths['/api/login'] = post('login', 'session', 'canopy.Signed', [401], { type: 'object', properties: { login: { type: 'string' }, password: { type: 'string', writeOnly: true } }, required: ['login', 'password'] });
  paths['/api/logout'] = post('logout', 'session', 'canopy.Signed', [], { type: 'object' });
  if (r.register) paths['/api/register'] = post('register', 'session', 'canopy.Signed', [], ref('canopy.Register'));
  return paths;
}

/** Every path /api serves for this graph. `fields` is the parsed fields per entity. */
export function apiPaths(graph, fields) {
  const paths = { '/api/openapi.json': get('openapi', 'contract', 'canopy.OpenAPI', []), ...sessionPaths(graph) };
  for (const entity of Object.keys(graph.data)) Object.assign(paths, entityPaths(graph, fields, entity));
  for (const l of graph.lists || []) {
    const ov = { ...(graph.override?.[`${l.entity}.list`] || {}), ...l };
    paths[`/api/list/${l.id}`] = get(`list_${l.id}`, 'lists', `${l.entity}.page`, [404], listParams(fields[l.entity], ov, { filters: false }));
  }
  for (const d of graph.dashboards || []) paths[`/api/dashboard/${d.id}`] = get(`dashboard_${d.id}`, 'dashboards', 'canopy.Dashboard', [404], [query('from', { type: 'string', format: 'date' }), query('to', { type: 'string', format: 'date' })]);
  if (graph.search) paths['/api/search'] = get('search', 'search', 'canopy.Search', [], [query('q')]);
  for (const a of (graph.actions || []).filter((x) => !x.in)) paths[`/api/action/${a.name}`] = post(`action_${a.name}`, 'actions', 'canopy.Done', [404], textInput(a.fields || []));
  return paths;
}
