// Scaffold renderer. Not a product UI — an admin-grade surface derived from the
// schema so a browser can reach the backend. Colours come from /theme, never CSS.
// `vc` is the view context: who is looking (user, role) and what they may do.
import { formatMoney, isStored } from './spec.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (name) => String(name).replace(/([A-Z])/g, ' $1').trim().replace(/^./, (c) => c.toUpperCase());
const plural = (word) => /[^aeiou]y$/i.test(word) ? word.slice(0, -1) + 'ies'
  : /(s|x|z|ch|sh)$/i.test(word) ? word + 'es' : word + 's';
export { esc, label };

const anyone = { user: null, role: null, can: () => true, canSee: () => true, ownField: () => null, ownWhere: () => ({}), enabled: false };

export function page(graph, { title, body, flash, vc = anyone }) {
  const bg = graph.theme?.background || 'white';
  const accent = graph.theme?.accent || 'navy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
<header><h1>${esc(graph.app)}</h1><nav>${navLinks(graph, vc)}${whoBox(graph, vc)}</nav></header>
<main>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}${body}</main></body></html>`;
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

// One value, formatted by its field kind. HTML out, already escaped.
export function fmt(store, entity, f, row, labels = {}) {
  return f.type.format(row[f.name], f, { esc, label, store, entity, row, labels });
}

const cell = (store, entity, fields, r, c, labels = {}) => {
  const f = fields.find((x) => x.name === c);
  return `<td>${f ? fmt(store, entity, f, r, labels) : esc(r[c])}</td>`;
};

// The buttons a row offers: built-ins, declared actions and state transitions.
function rowButtons(graph, store, entity, r, actions, vc) {
  return actions.map((a) => {
    if (a === 'view') return `<a class="btn" href="/${entity}/${r.id}">Open</a>`;
    if (a === 'edit') return vc.can(entity, 'edit', r) ? `<a class="btn" href="/${entity}/${r.id}/edit">Edit</a>` : '';
    if (a === 'delete') return vc.can(entity, 'delete', r) ? `<form class="inline" method="post" action="/${entity}/${r.id}/delete"><button type="submit">Delete</button></form>` : '';
    if (a.startsWith('go:')) {
      const t = transitionsFor(graph, entity, r, vc).find((x) => x.name === a.slice(3));
      return t ? `<form class="inline" method="post" action="/${entity}/${r.id}/go/${t.name}"><button type="submit">${esc(t.title || label(t.name))}</button></form>` : '';
    }
    if (!vc.can(entity, `do:${a}`, r)) return '';
    const act = (graph.actions || []).find((x) => x.name === a);
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

function rangeForm(entity, path, filters, ctx) {
  const ranges = filters.filter((f) => f.range);
  if (!ranges.length) return '';
  const inputs = ranges.map((f) => {
    const type = ctx.store.field(entity, f.field)?.type.temporal ? 'date' : 'number';
    return `<div class="range"><div><label for="${f.field}_from">${esc(f.name || label(f.field))} from</label>
      <input type="${type}" id="${f.field}_from" name="${f.field}_from" value="${esc(ctx.range?.[`${f.field}_from`] || '')}"></div>
      <div><label for="${f.field}_to">to</label><input type="${type}" id="${f.field}_to" name="${f.field}_to" value="${esc(ctx.range?.[`${f.field}_to`] || '')}"></div></div>`;
  }).join('');
  return `<form class="card" method="get" action="${path}">${inputs}<p><button type="submit">Apply</button> <a class="btn" href="${path}">Reset</a></p></form>`;
}

export function listView(graph, store, entity, fields, rows, ctx) {
  const vc = ctx.vc || anyone;
  const ov = graph.override?.[`${entity}.list`] || {};
  const cols = ov.columns || fields.filter((f) => !f.type.secret).map((f) => f.name);
  const actions = ov.rowActions ?? ['edit', 'delete'];
  const doneField = fields.find((f) => f.kind === 'bool');
  const path = ctx.path || `/${entity}`;

  const filters = (ov.filters || []).filter((f) => !f.range).map((f) => {
    const field = store.field(entity, f.field);
    let options = f.options;
    if (!options && field?.kind === 'ref') {
      options = [{ label: 'All' }, ...store.list(field.target, {}).map((r) => ({ label: store.label(field.target, r), eq: r.id }))];
    }
    if (!options && field?.kind === 'enum') {
      options = [{ label: 'All' }, ...field.options.map((o) => ({ label: label(o), eq: o }))];
    }
    if (!options && field?.kind === 'bool') {
      const pair = (ov.labels || {})[f.field] || ['No', 'Yes'];
      options = [{ label: 'All' }, { label: pair[1], eq: 1 }, { label: pair[0], eq: 0 }];
    }
    const links = options.map((o) => {
      const active = String(ctx.where[f.field] ?? '') === String(o.eq ?? '');
      const href = o.eq === undefined ? path : `${path}?${f.field}=${encodeURIComponent(o.eq)}`;
      return `<a class="btn" href="${href}"${active ? ' aria-current="true"' : ''}>${esc(o.label)}</a>`;
    }).join(' ');
    return `<div class="card"><strong>${esc(f.name || label(f.field))}</strong><div>${links}</div></div>`;
  }).join('') + rangeForm(entity, path, ov.filters || [], { ...ctx, store });

  const searchBox = (ov.search || []).length ? `<form class="card" method="get" action="${path}">
    <label for="q">Search</label>
    <input type="text" id="q" name="q" value="${esc(ctx.q)}" placeholder="Search ${esc(entity.toLowerCase())}s">
    <p><button type="submit">Search</button></p></form>` : '';

  const keep = new URLSearchParams(ctx.query || '');
  keep.delete('sort'); keep.delete('dir'); keep.delete('page');
  const sortHref = (c) => { const q = new URLSearchParams(keep); q.set('sort', c); q.set('dir', ctx.sort === c && ctx.dir === 'asc' ? 'desc' : 'asc'); return `${path}?${q}`; };
  const head = cols.map((c) => `<th><a href="${sortHref(c)}">${esc(label(c))}${ctx.sort === c ? (ctx.dir === 'asc' ? ' ▲' : ' ▼') : ''}</a></th>`).join('') + (actions.length ? '<th>Actions</th>' : '');
  const pageHref = (n) => { const q = new URLSearchParams(ctx.query || ''); q.set('page', String(n)); return `${path}?${q}`; };
  const pager = ctx.pages > 1 ? `<p class="pages">Page ${ctx.page} of ${ctx.pages} · ${ctx.page > 1 ? `<a href="${pageHref(ctx.page - 1)}">Previous</a>` : ''}${ctx.page < ctx.pages ? `<a href="${pageHref(ctx.page + 1)}">Next</a>` : ''}</p>` : '';
  const body = rows.map((r) => {
    const cells = cols.map((c) => cell(store, entity, fields, r, c, ov.labels || {})).join('');
    const btns = actions.length ? rowButtons(graph, store, entity, r, actions, vc) : '';
    const isDone = doneField && r[doneField.name] && ov.strikeDone !== false && doneField.name === 'done';
    return `<tr class="${isDone ? 'done' : ''}">${cells}${actions.length ? `<td>${btns}</td>` : ''}</tr>`;
  }).join('');

  const title = ov.title || plural(label(entity));
  const canCreate = ov.create !== false && vc.can(entity, 'create');
  return page(graph, {
    title, flash: ctx.flash, vc,
    body: `<h2>${esc(title)}</h2>${ov.intro ? `<p>${esc(ov.intro)}</p>` : ''}${searchBox}${filters}
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${ctx.total ?? rows.length} item(s) · <a href="${path}.csv${ctx.query ? `?${ctx.query}` : ''}">Export CSV</a></p>${pager}
      ${canCreate ? `<p><a class="btn" href="/${entity}/new">${esc(ov.createTitle || `Add ${label(entity)}`)}</a></p>` : ''}`,
  });
}

export function formFields(store, entity, fields, row, only, { skip = [] } = {}) {
  const statusField = store.graph?.states?.[entity]?.field;
  return fields.filter(isStored).filter((f) => !skip.includes(f.name) && (f.name !== statusField || only?.includes(f.name)))
    .filter((f) => (only ? only.includes(f.name) : true)).filter((f) => f.type.input).map((f) =>
      `<label for="f_${f.name}">${esc(label(f.name))}${f.required ? ' *' : ''}</label>${f.type.input(f, row?.[f.name], { esc, store, entity, row })}`).join('');
}

const enctype = (fields) => (fields.some((f) => f.type.upload) ? ' enctype="multipart/form-data"' : '');

export function formView(graph, store, entity, fields, row, mode, errors = [], vc = anyone, flash = '') {
  const ov = graph.override?.[`${entity}.form`] || {};
  const action = mode === 'new' ? `/${entity}` : `/${entity}/${row.id}`;
  const title = ov.title || (mode === 'new' ? `Add ${label(entity)}` : `Edit ${label(entity)}`);
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${
        errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  const skip = Object.keys(ov.fill || {});
  const own = vc.ownField(entity);
  if (own) skip.push(own);
  return page(graph, {
    title, vc, flash,
    body: `<h2>${esc(title)}</h2>${problems}${ov.intro ? `<p>${esc(ov.intro)}</p>` : ''}
      <form class="card" method="post" action="${action}"${enctype(fields)}>${formFields(store, entity, fields, row, ov.fields, { skip })}
      <p><button type="submit">${esc(ov.submit || (mode === 'new' ? 'Submit' : 'Save'))}</button>
      <a class="btn" href="/${entity}">Cancel</a></p></form>`,
  });
}

function transitionForms(graph, store, entity, fields, row, vc) {
  return transitionsFor(graph, entity, row, vc).map((t) =>
    `<form class="card inline-block" method="post" action="/${entity}/${row.id}/go/${t.name}">
      ${t.fields?.length ? formFields(store, entity, fields, row, t.fields) : ''}
      <p><button type="submit">${esc(t.title || label(t.name))}</button></p></form>`).join('');
}

export function detailView(graph, store, entity, fields, row, flash, vc = anyone) {
  const ov = graph.override?.[`${entity}.detail`] || {};
  const rows = fields.filter((f) => !f.type.secret).filter((f) => !ov.fields || ov.fields.includes(f.name)).map((f) =>
    `<tr><th>${esc(label(f.name))}</th><td>${fmt(store, entity, f, row, ov.labels || {})}</td></tr>`).join('');

  const related = (ov.related || []).map((rel) => {
    const kids = store.list(rel.entity, { where: { [rel.via]: row.id, ...vc.ownWhere(rel.entity) }, sort: { field: 'id', dir: 'asc' } });
    const kidFields = store.fields[rel.entity];
    const show = rel.columns || kidFields.filter((f) => f.name !== rel.via && !f.type.secret).map((f) => f.name);
    const body = kids.map((k) => `<tr>${show.map((c) => cell(store, rel.entity, kidFields, k, c)).join('')}${
      rel.rowActions ? `<td>${rowButtons(graph, store, rel.entity, k, rel.rowActions, vc)}</td>` : ''}</tr>`).join('');
    const form = rel.form === false || !vc.can(rel.entity, 'create') ? '' : `<form class="card" method="post" action="/${entity}/${row.id}/add/${rel.entity}"${enctype(kidFields)}>
      ${formFields(store, rel.entity, kidFields.filter((f) => f.name !== rel.via), {}, rel.form === true ? null : rel.form, { skip: Object.keys(rel.fill || {}) })}
      <p><button type="submit">${esc(rel.submit || `Add ${label(rel.entity)}`)}</button></p></form>`;
    return `<h3>${esc(rel.title || plural(label(rel.entity)))}</h3>
      <table><thead><tr>${show.map((c) => `<th>${esc(label(c))}</th>`).join('')}${rel.rowActions ? '<th>Actions</th>' : ''}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${kids.length} item(s)</p>${form}`;
  }).join('');

  const buttons = [
    vc.can(entity, 'edit', row) ? `<a class="btn" href="/${entity}/${row.id}/edit">Edit</a>` : '',
    ...(ov.actions || []).filter((a) => vc.can(entity, `do:${a}`, row)).map((a) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      return `<form class="inline" method="post" action="/${entity}/${row.id}/action/${a}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
    }),
    `<a class="btn" href="/${entity}">Back</a>`,
  ].filter(Boolean).join(' ');

  return page(graph, {
    title: `${label(entity)} ${store.label(entity, row)}`, flash, vc,
    body: `<h2>${esc(store.label(entity, row))}</h2><table>${rows}</table>
      <p>${buttons}</p>${transitionForms(graph, store, entity, fields, row, vc)}${related}`,
  });
}

const metricValue = (store, entity, fieldName, v) => {
  if (v === null || v === undefined) return '—';
  const f = fieldName ? store.field(entity, fieldName) : null;
  if (f?.kind === 'money') return formatMoney(Math.round(v));
  return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v;
};

export function dashboardView(graph, store, dash, flash, vc = anyone, period = {}) {
  const inPeriod = (entity, where = {}) => {
    const f = dash.period?.[entity];
    if (!f || (!period.from && !period.to)) return where;
    const kind = store.field(entity, f).kind;
    const range = {};
    if (period.from) range.gte = kind === 'time' ? `${period.from}T00:00:00` : period.from;
    if (period.to) range.lte = kind === 'time' ? `${period.to}T23:59:59.999Z` : period.to;
    return { ...where, [f]: range };
  };
  const periodForm = dash.period ? `<form class="card" method="get" action="/dashboard/${dash.id}"><div class="range">
      <div><label for="from">From</label><input type="date" id="from" name="from" value="${esc(period.from || '')}"></div>
      <div><label for="to">To</label><input type="date" id="to" name="to" value="${esc(period.to || '')}"></div>
      <div><button type="submit">Apply</button> <a class="btn" href="/dashboard/${dash.id}">All time</a></div></div></form>` : '';
  const cards = (dash.cards || []).map((c) => {
    const [row] = store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: inPeriod(c.entity, c.where || {}) });
    const v = row?.v ?? 0;
    return `<div class="metric"><b>${esc(metricValue(store, c.entity, c.fn === 'count' || !c.fn ? null : c.field, v))}</b>${esc(c.title)}</div>`;
  }).join('');
  const tables = (dash.tables || []).map((t) => {
    const rows = store.aggregate(t.entity, { ...t, where: inPeriod(t.entity, t.where || {}) });
    const groupField = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    const head = (t.groupBy ? `<th>${esc(t.groupTitle || label(t.groupBy))}</th>` : '') +
      (t.metrics || []).map((m) => `<th>${esc(m.title ?? label(m.as))}</th>`).join('');
    const body = rows.map((r) => {
      let g = r.grp;
      if (groupField?.kind === 'ref') g = store.label(groupField.target, store.get(groupField.target, g)) || null;
      if (groupField?.kind === 'enum') g = g === null ? null : label(g);
      if (groupField?.kind === 'bool') g = g ? 'Yes' : 'No';
      return `<tr>${t.groupBy ? `<td>${esc(g ?? '—')}</td>` : ''}${
        (t.metrics ?? []).map((m) => `<td>${esc(metricValue(store, t.entity, m.fn === 'count' ? null : m.field, r[m.as]))}</td>`).join('')}</tr>`;
    }).join('');
    return `<h3>${esc(t.title)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
  return page(graph, {
    title: dash.title, flash, vc,
    body: `<h2>${esc(dash.title)}</h2>${dash.intro ? `<p>${esc(dash.intro)}</p>` : ''}${periodForm}
      <div class="metrics">${cards}</div>${tables}`,
  });
}

export function staticPage(graph, p, flash, vc = anyone) {
  const body = (p.body || []).map((t) => `<p>${esc(t)}</p>`).join('');
  const links = (p.links || []).map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(' ');
  const buttons = (p.actions || []).map((a) => {
    const act = (graph.actions || []).find((x) => x.name === a);
    return `<form class="inline" method="post" action="/action/${esc(a)}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
  }).join(' ');
  return page(graph, { title: p.title, flash, vc,
    body: `<h2>${esc(p.heading || p.title)}</h2><div class="card">${body}${buttons ? `<p>${buttons}</p>` : ''}</div><p>${links}</p>` });
}

export function loginView(graph, { error = '', next = '', login = '' } = {}, vc = anyone) {
  const problems = error ? `<div class="card"><p class="error">${esc(error)}</p></div>` : '';
  return page(graph, { title: 'Login', vc,
    body: `<h2>Login</h2>${problems}<form class="card" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="login">${esc(label(graph.roles.login))}</label><input type="text" id="login" name="login" value="${esc(login)}" required>
      <label for="password">Password</label><input type="password" id="password" name="password" required>
      <p><button type="submit">Login</button>${graph.roles.register ? ` <a class="btn" href="/register">Register</a>` : ''}</p></form>` });
}

export function registerView(graph, store, fields, submitted = {}, errors = [], vc = anyone) {
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  const skip = [graph.roles.role];
  return page(graph, { title: 'Register', vc,
    body: `<h2>Register</h2>${problems}<form class="card" method="post" action="/register"${enctype(fields)}>
      ${formFields(store, graph.roles.entity, fields, submitted, null, { skip })}
      <p><button type="submit">Register</button> <a class="btn" href="/login">Login</a></p></form>` });
}

export function outboxView(graph, rows, flash, vc = anyone) {
  const body = rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.kind)}</td><td>${esc(r.connector)}</td><td>${esc(r.target)}</td>
    <td><span class="status">${esc(r.status)}</span>${r.code ? ` ${r.code}` : ''}${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}</td>
    <td><pre class="muted">${esc(JSON.stringify(r.payload, null, 1))}</pre></td><td>${esc(r.updatedAt)}</td>
    <td>${r.status === 'failed' ? `<form class="inline" method="post" action="/outbox/${r.id}/retry"><button type="submit">Retry</button></form>` : ''}</td></tr>`).join('');
  return page(graph, { title: 'Outbox', flash, vc,
    body: `<h2>Outbox</h2><p class="muted">Everything the application sent out, with its delivery status.</p>
      <table><thead><tr><th>#</th><th>Kind</th><th>Connector</th><th>Target</th><th>Status</th><th>Payload</th><th>Updated</th><th></th></tr></thead>
      <tbody>${body}</tbody></table><p class="muted">${rows.length} item(s)</p>` });
}

export function forbiddenPage(graph, vc = anyone, message = 'You are not allowed to do this.') {
  return page(graph, { title: 'Forbidden', vc,
    body: `<h2>Forbidden</h2><div class="card"><p class="error">${esc(message)}</p>${vc.user ? '' : '<p><a class="btn" href="/login">Login</a></p>'}</div>` });
}

// CSV: one line per row, cells quoted when they need it, formatted like the page but without HTML.
export function csv(header, rows) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
// A cell's plain-text value for export: labels for references and booleans, money as 12.34.
export function plain(store, entity, f, row, labels = {}) {
  const v = row[f.name];
  if (f.kind === 'ref') { const t = store.get(f.target, v); return t ? store.label(f.target, t) : ''; }
  if (f.kind === 'bool') { const pair = labels[f.name] || ['No', 'Yes']; return v ? pair[1] : pair[0]; }
  if (f.kind === 'money') return formatMoney(v);
  if (f.type.secret) return '';
  return v ?? '';
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
