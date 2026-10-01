// `/plugins` itself is just a list of module paths — whether each module
// actually loads, and what it registers, is decided at load time (registry.mjs)
// and reported through the same error shape (see runtime/cli.mjs, server.mjs).
export const NODES = ['plugins'];

export function check(graph, h) {
  if (graph.plugins !== undefined && !Array.isArray(graph.plugins))
    h.err('/plugins', 'plugins is a list of module paths', '["./plugins/loyalty.mjs"]');
  // An asynchronous driver (Driver#async) answers every store call with a Promise. A plugin whose blocks were not written for that
  // (`async: true`) would read a Promise where it expects a row and corrupt data without an exception: refused here, before it runs.
  if (!h.asyncDriver) return;
  const listed = Array.isArray(graph.plugins) ? graph.plugins : [];
  for (const name of h.registry.legacy || []) {
    const at = listed.indexOf(name);
    h.err(at === -1 ? '/plugins' : `/plugins/${at}`, `plugin "${name}" is written for a synchronous store, and the configured driver is asynchronous`,
      'await store.*, resolve and text in its blocks, then export `async: true` (docs/FORMAT.md "Plugins")');
  }
}
