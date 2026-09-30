// /search?q=: one result section per entity /search names (item 7) — each
// entity's own Entity.list "search" fields and the viewer's own permissions,
// the same machinery a saved list's search box already uses.
import { esc, label, plural, anyone, noPre, columnsOf, page, cell } from '../render.mjs';

export function searchView(graph, store, q, results, vc = anyone, pre = noPre) {
  const sections = results.map(({ entity, rows }) => {
    const fields = store.fields[entity];
    const ov = graph.override?.[`${entity}.list`] || {};
    const cols = columnsOf(ov, fields);
    const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('');
    const body = rows.map((r) => `<tr>${cols.map((c) => cell(store, entity, fields, r, c, ov.labels || {}, vc, pre)).join('')}</tr>`).join('');
    return `<h3>${esc(ov.title || plural(label(entity)))}</h3>${rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : '<p class="muted">No matches.</p>'}`;
  }).join('');
  const title = graph.search.title || 'Search';
  return page(graph, { title, vc,
    body: `<h2>${esc(title)}</h2><form class="card" method="get" action="/search">
      <label for="q">Search</label><input type="text" id="q" name="q" value="${esc(q)}">
      <p><button type="submit">Search</button></p></form>${q ? sections : ''}` });
}
