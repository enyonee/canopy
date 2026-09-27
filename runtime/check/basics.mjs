// The seven top-level kinds with no structure of their own to check: `app` is
// just a required name, `task`/`note`/`theme`/`home`/`allowDestructive` are
// read as-is by the runtime (never rejected here), and `views` may only be
// "auto" — screens come from /data, shaped by /override.
import { near } from './util.mjs';

export const NODES = ['app', 'task', 'note', 'theme', 'home', 'views', 'allowDestructive'];

// Unknown top-level keys and the required /app name: checked before /data is
// known to exist, so a graph missing both still names every top-level problem.
export function checkTop(graph, h, TOP) {
  const { err } = h;
  for (const k of Object.keys(graph)) {
    if (!TOP.includes(k)) {
      const n = near(k, TOP);
      err(`/${k}`, `unknown node "${k}"`, n.length ? `did you mean: ${n.join(', ')}?` : `nodes are: ${TOP.join(', ')}`);
    }
  }
  if (!graph.app) err('/app', 'missing application name');
}

// Screens are derived, never listed: checked once /data (and so /override) exists.
export function checkViews(graph, h) {
  if (graph.views !== undefined && graph.views !== 'auto')
    h.err('/views', 'only "auto" is supported', 'screens are derived from /data; shape them in /override');
}
