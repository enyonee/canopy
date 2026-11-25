// app.json + OpenAPI → every file of the front end, in memory.
import { buildModel } from './model.mjs';
import { emit } from './emit.mjs';
import { typesOf } from './types.mjs';
import { readTemplate, project } from './files.mjs';

// Keys sorted at every depth: the snapshot does not depend on how the document was written.
export const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);

export async function generate(graph, openapi, { template = readTemplate() } = {}) {
  const doc = canonical(openapi);
  const model = buildModel(graph, doc);
  return { model, files: project(template, emit(model, doc, await typesOf(doc))) };
}
