// "web": the directory of the app's built front, relative to app.json (typically "web/dist"). Only its shape is
// checked here — a string naming a directory below the app's own, never the app directory itself (which holds
// app.json, the database and the session key), never outside it, never a hidden or dependency directory and never
// the uploads (`files/`) or `plugins/`. Whether it has been built is a question for
// the server at start (runtime/web.mjs#webProblems): the graph is written before its front is built.
export const NODES = ['web'];

// The app's own directories next to app.json: what each holds, for the message.
const OWN = { files: 'the uploads (they are served only through /file, with the view and own checks)', plugins: 'the server-side plugins' };

export function check(graph, h) {
  const w = graph.web;
  if (w === undefined) return;
  const hint = 'name the built front\'s directory relative to app.json, e.g. "web": "web/dist"';
  if (typeof w !== 'string' || !w.trim()) { h.err('/web', 'web must be a non-empty string', hint); return; }
  if (/[\\\x00-\x1f]/.test(w)) { h.err('/web', `"${w}" has a backslash or a control character`, `${hint}, with forward slashes`); return; }
  if (/^\/|^[A-Za-z]:/.test(w)) { h.err('/web', `"${w}" is an absolute path`, hint); return; }
  const segs = w.split('/').filter((s) => s && s !== '.');
  if (segs.includes('..')) { h.err('/web', `"${w}" leaves the app directory`, hint); return; }
  if (!segs.length) { h.err('/web', `"${w}" is the app directory itself, which holds app.json, the database and the session key`, hint); return; }
  // Everything below `web` is served to anyone, unchecked: never a directory the app keeps for itself.
  const hidden = segs.find((x) => x.startsWith('.') || x === 'node_modules');
  if (hidden) { h.err('/web', `"${w}" goes through "${hidden}", a hidden or dependency directory`, hint); return; }
  if (OWN[segs[0]]) h.err('/web', `"${w}" is inside ${segs[0]}/, ${OWN[segs[0]]}: everything in it would be served at / to anyone`, hint);
}
