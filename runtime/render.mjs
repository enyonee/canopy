// Scaffold renderer: the shell (the page frame, nav, colours) and the small
// primitives every view shares (escaping, one field's HTML, a row's action
// buttons, which transitions a row offers). Not a product UI — an admin-grade
// surface derived from the schema so a browser can reach the backend. The
// actual views (list/form/detail/dashboard/static pages) are one file each
// under runtime/render/, all built on what this module exports.
import { formatMoney } from './spec.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (name) => String(name).replace(/([A-Z])/g, ' $1').trim().replace(/^./, (c) => c.toUpperCase());
export const plural = (word) => /[^aeiou]y$/i.test(word) ? word.slice(0, -1) + 'ies'
  : /(s|x|z|ch|sh)$/i.test(word) ? word + 'es' : word + 's';
export { esc, label };

/** @type {import('./types.d.ts').ViewContext} */
export const anyone = { user: null, role: null, can: (_e, _op, _row) => true, canSee: (_item) => true, isAdmin: true, ownField: (_e) => null, ownWhere: (_e) => ({}), ownOk: (_e, _row, _op) => true, enabled: false };

export function page(graph, { title, body, flash = '', vc = anyone, refresh = null }) {
  const bg = graph.theme?.background || 'white';
  const accent = graph.theme?.accent || 'navy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">` : ''}
<title>${esc(title)} — ${esc(graph.app)}</title><style>
body { background: ${bg}; color: #16181d; font: 16px/1.5 system-ui, sans-serif; margin: 0; }
header { background: ${accent}; color: white; padding: 16px 24px; }
header h1 { margin: 0 0 8px; font-size: 20px; }
nav a { color: white; margin-right: 14px; text-decoration: underline; }
nav .who { float: right; }
nav .who form { display: inline; }
nav .who button { background: white; color: ${accent}; padding: 2px 8px; margin-left: 8px; }
main { max-width: 940px; margin: 24px auto; padding: 0 16px; }
h2, h3 { color: ${accent}; }
.card { background: white; border: 2px solid ${accent}; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.flash { background: ${accent}; color: white; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
.error { color: #b00020; font-weight: 600; }
table { width: 100%; border-collapse: collapse; background: white; border: 2px solid ${accent}; margin-bottom: 16px; }
th { background: ${accent}; color: white; text-align: left; padding: 8px; }
td { padding: 8px; border-top: 1px solid #ddd; vertical-align: top; }
tr.done td { text-decoration: line-through; opacity: .65; }
button, .btn { background: ${accent}; color: white; border: 0; border-radius: 6px;
  padding: 6px 12px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }
label { display: block; margin: 12px 0 4px; font-weight: 600; color: ${accent}; }
input[type=text], input[type=number], input[type=date], input[type=password], input[type=email], textarea, select {
  width: 100%; padding: 8px; border: 1px solid ${accent}; border-radius: 6px; font: inherit; box-sizing: border-box; }
form.inline { display: inline; }
.metrics { display: flex; flex-wrap: wrap; gap: 12px; }
.metric { flex: 1 1 180px; background: white; border: 2px solid ${accent}; border-radius: 8px; padding: 12px; }
.metric b { display: block; font-size: 26px; color: ${accent}; }
.muted { color: #555; font-size: 14px; }
.status { display: inline-block; border: 1px solid ${accent}; color: ${accent}; border-radius: 12px; padding: 0 10px; font-size: 14px; }
.range { display: flex; gap: 12px; align-items: end; }
.range label { margin-top: 0; }
.thumb { max-height: 80px; max-width: 120px; border-radius: 4px; }
th a { color: white; }
.pages a { margin-right: 12px; }
</style></head><body>
<header><h1>${esc(graph.app)}</h1><nav>${navLinks(graph, vc)}${searchBox(graph)}${whoBox(graph, vc)}</nav></header>
<main>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}${body}</main></body></html>`;
}

// The header search box (item 7's "/search?q=" node): present whenever the graph
// declares /search, regardless of role — /search itself narrows every section by
// the viewer's own permissions, same as any other read.
function searchBox(graph) {
  if (!graph.search) return '';
  return `<form class="who" method="get" action="/search"><input type="text" name="q" placeholder="${esc(graph.search.title || 'Search')}"></form>`;
}

function whoBox(graph, vc) {
  if (!graph.roles) return '';
  if (!vc.user) return `<span class="who"><a href="/login">Login</a>${graph.roles.register ? '<a href="/register">Register</a>' : ''}</span>`;
  const name = vc.user[graph.roles.login];
  return `<span class="who">Signed in as ${esc(name)} (${esc(vc.role)})<form method="post" action="/logout"><button type="submit">Logout</button></form></span>`;
}

function navLinks(graph, vc) {
  const out = [];
  for (const p of graph.pages || []) if (vc.canSee(p)) out.push(`<a href="/page/${p.id}">${esc(p.title)}</a>`);
  for (const entity of Object.keys(graph.data)) {
    const ov = graph.override?.[`${entity}.list`] || {};
    if (ov.hidden || !vc.can(entity, 'view')) continue;
    out.push(`<a href="/${entity}">${esc(ov.title || plural(label(entity)))}</a>`);
  }
  for (const l of graph.lists || []) if (!l.hidden && vc.canSee(l)) out.push(`<a href="/list/${l.id}">${esc(l.title)}</a>`);
  for (const d of graph.dashboards || []) if (vc.canSee(d)) out.push(`<a href="/dashboard/${d.id}">${esc(d.title)}</a>`);
  if (graph.connectors && vc.outbox) out.push('<a href="/outbox">Outbox</a>');
  return out.join('');
}

// Item 17: "Entity.detail".private redacts one field to just the user its named
// (direct, ref:<roles.entity>) owner field names, plus any admin — one predicate,
// consulted by every output a field can reach (HTML detail/list, JSON, CSV), so
// declaring it once on ".detail" is never bypassed by reading the row another way.
function mayReadField(graph, entity, field, row, vc = anyone) {
  const owner = graph?.override?.[`${entity}.detail`]?.private?.[field];
  if (!owner || !row) return true;
  if (vc.isAdmin) return true;
  return vc.user ? String(row[owner]) === String(vc.user.id) : false;
}
const HIDDEN = '<span class="muted">Hidden</span>';

// One value, formatted by its field kind. HTML out, already escaped.
export function fmt(store, entity, f, row, labels = {}, vc = anyone) {
  if (!mayReadField(store.graph, entity, f.name, row, vc)) return HIDDEN;
  return f.type.format(row[f.name], f, { esc, label, store, entity, row, labels });
}

export const cell = (store, entity, fields, r, c, labels = {}, vc = anyone) => {
  const f = fields.find((x) => x.name === c);
  return `<td>${f ? fmt(store, entity, f, r, labels, vc) : esc(r[c])}</td>`;
};

// Whether this viewer may run this declared action on this row — the one
// predicate both a row's action button and routes/rows.mjs's POST handler
// consult, so a button is never offered for a request the server would then
// refuse (item 2's fix: rowButtons used to ask the matrix alone, ignoring a
// "by" grant, and could render a button the handler then rejected — or hide
// one the handler would have allowed). "by" names the roles directly and
// still leaves the row scoped by any "own" grant on the entity, unless the
// action's own op ("do:<name>") is itself one of that grant's "all" ops.
export function mayRunAction(vc, entity, action, row) {
  if (action.by) return action.by.includes(vc.role) && vc.ownOk(entity, row, `do:${action.name}`);
  return vc.can(entity, `do:${action.name}`, row);
}

// The buttons a row offers: built-ins, declared actions and state transitions.
export function rowButtons(graph, store, entity, r, actions, vc) {
  return actions.map((a) => {
    if (a === 'view') return `<a class="btn" href="/${entity}/${r.id}">Open</a>`;
    if (a === 'edit') return vc.can(entity, 'edit', r) ? `<a class="btn" href="/${entity}/${r.id}/edit">Edit</a>` : '';
    if (a === 'delete') return vc.can(entity, 'delete', r) ? `<form class="inline" method="post" action="/${entity}/${r.id}/delete"><button type="submit">Delete</button></form>` : '';
    if (a.startsWith('go:')) {
      const t = transitionsFor(graph, entity, r, vc).find((x) => x.name === a.slice(3));
      return t ? `<form class="inline" method="post" action="/${entity}/${r.id}/go/${t.name}"><button type="submit">${esc(t.title || label(t.name))}</button></form>` : '';
    }
    const act = (graph.actions || []).find((x) => x.name === a);
    // No declaration to consult (only reachable with a hand-built graph that
    // skipped the checker, which requires "a" to be a real action): fall back
    // to the matrix alone, same as before item 2.
    if (!(act ? mayRunAction(vc, entity, act, r) : vc.can(entity, `do:${a}`, r))) return '';
    const toggled = act?.do?.find((s) => s.block === 'db.toggle');
    const caption = toggled && r[toggled.field] ? (act.altTitle || act.title || label(a)) : (act?.title || label(a));
    return `<form class="inline" method="post" action="/${entity}/${r.id}/action/${a}"><button type="submit">${esc(caption)}</button></form>`;
  }).filter(Boolean).join(' ');
}

// Transitions available on this row for this viewer: status in "from", role in "by", permission go:<name>.
export function transitionsFor(graph, entity, row, vc = anyone) {
  const st = graph.states?.[entity];
  if (!st) return [];
  return (st.transitions || []).filter((t) => {
    const from = t.from === undefined || t.from === '*' ? null : Array.isArray(t.from) ? t.from : [t.from];
    if (from && !from.includes(row[st.field])) return false;
    if (t.by && !t.by.includes(vc.role)) return false;
    return vc.can(entity, `go:${t.name}`, row);
  });
}

export const enctype = (fields) => (fields.some((f) => f.type.upload) ? ' enctype="multipart/form-data"' : '');

// CSV: one line per row, cells quoted when they need it, formatted like the page but without HTML.
export function csv(header, rows) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
// A cell's plain-text value for export: labels for references and booleans, money as 12.34.
export function plain(store, entity, f, row, labels = {}, vc = anyone) {
  if (!mayReadField(store.graph, entity, f.name, row, vc)) return 'Hidden';
  const v = row[f.name];
  if (f.kind === 'ref') { const t = store.get(f.target, v); return t ? store.label(f.target, t) : ''; }
  if (f.kind === 'bool') { const pair = labels[f.name] || ['No', 'Yes']; return v ? pair[1] : pair[0]; }
  if (f.kind === 'money') return formatMoney(v);
  if (f.type.secret) return '';
  return v ?? '';
}

// A field's JSON-answer value: structured data, not a display string (a ref
// stays the raw id, money becomes a major-unit number, a bool a real boolean).
// Secret fields are the caller's job to drop — rowJSON below does that once.
function toJSON(v, f) {
  if (v === null || v === undefined) return null;
  if (f.kind === 'money') return Number(formatMoney(v));
  if (f.kind === 'bool') return Boolean(v);
  return v;
}

// The JSON shape of one row for the JSON-answers routes (docs/FORMAT.md's
// «JSON answers») and for a detail widget's `data-row`: every stored and
// derived field except secrets (derived values are already computed by
// store.hydrate() by the time a route calls this).
export function rowJSON(store, entity, fields, row, vc = anyone) {
  const out = { id: row.id };
  for (const f of fields) if (!f.type.secret) out[f.name] = mayReadField(store.graph, entity, f.name, row, vc) ? toJSON(row[f.name], f) : null;
  return out;
}

// `<div class="widget" data-widget="…" data-props='…' data-row='…'>` + a
// noscript fallback + the module script tag — the one place both a page
// widget (no row) and a detail widget (row given) build this markup.
/** @param {{ row?: any }} [opts] */
export function widgetBlock(node, opts) {
  const { row } = opts || {};
  const props = { ...node };
  delete props.use;
  // Item 18: a prop may read the row server-side ("@row.field", resolved from the
  // same JSON shape rowJSON already computes — secrets dropped, derived included),
  // instead of the model having to name every value in the graph by hand.
  for (const [k, v] of Object.entries(props)) if (typeof v === 'string' && v.startsWith('@row.')) props[k] = row ? row[v.slice(5)] : null;
  const rowAttr = row !== undefined ? ` data-row='${esc(JSON.stringify(row))}'` : '';
  return `<div class="widget" data-widget="${esc(node.use)}" data-props='${esc(JSON.stringify(props))}'${rowAttr}>
    <noscript>This page needs JavaScript to show the ${esc(node.use)} widget.</noscript></div>
    <script type="module" src="/widget/${esc(node.use)}.mjs"></script>`;
}

export function forbiddenPage(graph, vc = anyone, message = 'You are not allowed to do this.') {
  return page(graph, { title: 'Forbidden', vc,
    body: `<h2>Forbidden</h2><div class="card"><p class="error">${esc(message)}</p>${vc.user ? '' : '<p><a class="btn" href="/login">Login</a></p>'}</div>` });
}

export function noticePage(graph, vc = anyone, title = 'Notice', message = '') {
  return page(graph, { title, vc, body: `<h2>${esc(title)}</h2><div class="card"><p class="error">${esc(message)}</p><p><a class="btn" href="/">Back</a></p></div>` });
}

export function errorPage(graph, errors) {
  return page(graph || { app: 'invalid graph', data: {} }, {
    title: 'Graph is invalid',
    body: `<h2>Graph is invalid</h2><pre class="card">${esc(errors)}</pre>`,
  });
}
