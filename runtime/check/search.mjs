// `/search`: site-wide search at /search?q= (item 7) — one result section per
// named entity, using that entity's own Entity.list "search" fields and the
// viewer's permissions; the header search box (render.mjs) shows whenever
// this node is declared.
export const NODES = ['search'];

export function check(graph, h) {
  const { err, checkEntity } = h;
  const s = graph.search;
  if (!s) return;
  if (!Array.isArray(s.entities) || !s.entities.length) { err('/search/entities', 'search needs "entities": a non-empty array of entity names'); return; }
  s.entities.forEach((e, i) => checkEntity(e, `/search/entities/${i}`));
  if (s.title !== undefined && typeof s.title !== 'string') err('/search/title', 'title must be a string');
}
