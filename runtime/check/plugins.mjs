// `/plugins` itself is just a list of module paths — whether each module
// actually loads, and what it registers, is decided at load time (registry.mjs)
// and reported through the same error shape (see runtime/cli.mjs, server.mjs).
export const NODES = ['plugins'];

export function check(graph, h) {
  if (graph.plugins !== undefined && !Array.isArray(graph.plugins))
    h.err('/plugins', 'plugins is a list of module paths', '["./plugins/loyalty.mjs"]');
}
