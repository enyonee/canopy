// Shared by every checker: a name that does not exist gets its closest matches
// from the pool that does, so the message doubles as a repair suggestion.
export const near = (word, pool) => {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return pool.map((p) => [d(String(word).toLowerCase(), p.toLowerCase()), p]).sort((a, b) => a[0] - b[0])
    .filter(([n]) => n <= 3).slice(0, 3).map(([, p]) => p);
};

// A widget node — `{ "use": "chess", ...props }` — attached to `pages[].widget`
// or `"Entity.detail".widget`. Shared by check/pages.mjs and check/override.mjs
// (the two places a widget can be declared) so "unknown widget"/"missing prop"
// read the same way in both; `entity` is null for a page widget.
export function checkWidget(h, node, path, entity) {
  const { err, registry, fields, graph, checkEntity, checkField } = h;
  if (!node || typeof node !== 'object' || !node.use) { err(path, 'a widget needs "use": the registered widget name'); return; }
  const w = registry.widgets[node.use];
  if (!w) {
    const n = near(node.use, Object.keys(registry.widgets));
    err(`${path}/use`, `unknown widget "${node.use}"`,
      n.length ? `did you mean: ${n.join(', ')}?` : `known widgets: ${Object.keys(registry.widgets).join(', ') || '(none registered)'}`);
    return;
  }
  for (const key of w.props || []) if (node[key] === undefined) err(path, `widget "${node.use}" requires prop "${key}"`, w.summary);
  if (w.check) w.check(node, { err, fields, entity, graph, path, checkEntity, checkField });
}
