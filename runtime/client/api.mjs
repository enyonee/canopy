// Shared browser-side helper for widget client modules, served at
// /widget/_api.mjs (runtime/routes/widgets.mjs reads this file's own source
// and hands it out verbatim — nothing here is ever imported by the server).
// `api.get`/`api.post` talk to the graph's own routes and ask for a JSON
// answer; `mountWidgets` finds every element the server rendered for a widget
// name and calls its `mount(el, { props, row, api })` — the one piece of
// bootstrapping every widget module would otherwise repeat. `doc` is
// injectable (default the real `document`) so this file runs under node:test
// without a DOM — see tests/widgets.test.mjs — and stays 100% line-covered
// like every other runtime module. The `/** @type {any} */` cast is only
// there because this project's tsconfig has no "dom" lib configured:
// `document` is a real browser global, not a type this checker needs to know
// about anywhere else.
// A POST body stays form-encoded (the same shape every <form> on the scaffold
// already posts, and every route already parses) — only the *answer* is JSON,
// asked for the same way a GET is: the Accept header, nothing new to parse.
const form = (body) => new URLSearchParams(Object.entries(body ?? {}).map(([k, v]) => [k, String(v)]));

export const api = {
  get: (path) => fetch(path, { headers: { accept: 'application/json' } }).then((r) => r.json()),
  post: (path, body) => fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form(body).toString(),
  }).then((r) => r.json()),
};

export function mountWidgets(name, mount, doc = /** @type {any} */ (globalThis).document) {
  for (const el of doc.querySelectorAll(`[data-widget="${name}"]`)) {
    const props = JSON.parse(el.dataset.props || '{}');
    const row = el.dataset.row ? JSON.parse(el.dataset.row) : undefined;
    mount(el, { props, row, api });
  }
}
