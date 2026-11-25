// The OpenAPI 3.1 document of an app's /api, derived from the graph and nothing else: the same document for every
// viewer and every run (the keys are sorted, the arrays keep the graph's order), so two documents compare byte for byte.
// Served at GET /api/openapi.json (routes/api.mjs) and written by `run.mjs <app.json> --openapi [--out file]` (cli.mjs).
// It names no permission: what a role may do is decided per request, and any call may answer 403.
import { parseField } from './spec.mjs';
import { captioned } from './render.mjs';
import { registerFields } from './render/pages.mjs';
import { ref, rowSchema, writableFields, inputSchema, pageSchema, savedSchema, signedSchema, commonSchemas } from './contract/schemas.mjs';
import { apiPaths, refusalResponses } from './contract/paths.mjs';

// The schemas of one entity: its row, the body of a create or an edit, a page of rows and a write's answer.
function entitySchemas(graph, entity, fields, all) {
  const form = graph.override?.[`${entity}.form`] || {};
  const body = writableFields(fields, { only: form.fields || null, skip: [graph.states?.[entity]?.field, ...Object.keys(form.fill || {})] });
  return {
    [entity]: rowSchema(fields, captioned(graph, all, entity)),
    [`${entity}.input`]: inputSchema(body),
    [`${entity}.page`]: pageSchema(ref(entity)),
    [`${entity}.saved`]: savedSchema(ref(entity)),
  };
}

// "who am I", the session answers and the registration body (the user entity's fields, never its role).
function sessionSchemas(graph, fields) {
  const r = graph.roles;
  const user = r ? ref(r.entity) : { type: 'null' };
  const out = {
    'canopy.Me': { type: 'object', properties: { user: { oneOf: [user, { type: 'null' }] }, role: { type: ['string', 'null'] } }, required: ['user', 'role'] },
    'canopy.OpenAPI': { type: 'object', description: 'this document' },
  };
  if (!r) return out;
  out['canopy.Signed'] = signedSchema(user);
  // The fields the sign-up form asks for (the same registerFields routes/session.mjs writes through), less any upload.
  if (r.register) out['canopy.Register'] = inputSchema(writableFields(fields[r.entity], { only: registerFields(graph, { graph, fields }) }));
  return out;
}

// Object keys sorted at every depth; arrays keep their order.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);

/**
 * The OpenAPI document of a valid graph. `registry` supplies the field kinds and functions its specs name.
 * @param {any} graph @param {{ fields: any, functions?: any }} registry
 */
export function openapi(graph, registry) {
  const fields = Object.fromEntries(Object.entries(graph.data).map(([e, spec]) => [e, Object.entries(spec).map(([n, s]) => parseField(n, s, registry.fields, registry.functions))]));
  const schemas = { ...commonSchemas(), ...sessionSchemas(graph, fields) };
  for (const e of Object.keys(graph.data)) Object.assign(schemas, entitySchemas(graph, e, fields[e], fields));
  const components = { schemas, responses: refusalResponses() };
  if (graph.roles) components.securitySchemes = { session: { type: 'apiKey', in: 'cookie', name: 'ag_session' } };
  return canonical({
    openapi: '3.1.0',
    info: { title: graph.app || 'app', version: '1', description: 'Derived from app.json by the Canopy runtime. Every route answers JSON; a POST needs a JSON body and the Origin of this site.' },
    paths: apiPaths(graph, fields),
    components,
  });
}

/** The document as text: what GET /api/openapi.json sends and what --openapi writes, byte for byte. */
export const openapiText = (graph, registry) => `${JSON.stringify(openapi(graph, registry), null, 2)}\n`;
