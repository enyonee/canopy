// Scaffold renderer. Not a product UI — an admin-grade surface derived from the
// schema so a browser can reach the backend. Colours come from /theme, never CSS.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (name) => String(name).replace(/([A-Z])/g, ' $1').trim().replace(/^./, (c) => c.toUpperCase());
const plural = (word) => /[^aeiou]y$/i.test(word) ? word.slice(0, -1) + 'ies'
  : /(s|x|z|ch|sh)$/i.test(word) ? word + 'es' : word + 's';
export { esc, label };

export function page(graph, { title, body, flash }) {
  const bg = graph.theme?.background || 'white';
  const accent = graph.theme?.accent || 'navy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(graph.app)}</title><style>
body { background: ${bg}; color: #16181d; font: 16px/1.5 system-ui, sans-serif; margin: 0; }
header { background: ${accent}; color: white; padding: 16px 24px; }
header h1 { margin: 0 0 8px; font-size: 20px; }
nav a { color: white; margin-right: 14px; text-decoration: underline; }
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
input[type=text], input[type=number], textarea, select {
  width: 100%; padding: 8px; border: 1px solid ${accent}; border-radius: 6px; font: inherit; box-sizing: border-box; }
form.inline { display: inline; }
.metrics { display: flex; flex-wrap: wrap; gap: 12px; }
.metric { flex: 1 1 180px; background: white; border: 2px solid ${accent}; border-radius: 8px; padding: 12px; }
.metric b { display: block; font-size: 26px; color: ${accent}; }
.muted { color: #555; font-size: 14px; }
</style></head><body>
<header><h1>${esc(graph.app)}</h1><nav>${navLinks(graph)}</nav></header>
<main>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}${body}</main></body></html>`;
}

function navLinks(graph) {
  const out = [];
  for (const p of graph.pages || []) out.push(`<a href="/page/${p.id}">${esc(p.title)}</a>`);
  for (const entity of Object.keys(graph.data)) {
    const ov = graph.override?.[`${entity}.list`] || {};
    if (ov.hidden) continue;
    out.push(`<a href="/${entity}">${esc(ov.title || plural(label(entity)))}</a>`);
  }
  for (const l of graph.lists || []) if (!l.hidden) out.push(`<a href="/list/${l.id}">${esc(l.title)}</a>`);
  for (const d of graph.dashboards || []) out.push(`<a href="/dashboard/${d.id}">${esc(d.title)}</a>`);
  return out.join('');
}

const cell = (store, fields, r, c, labels = {}) => {
  const f = fields.find((x) => x.name === c);
  const v = r[c];
  if (!f) return `<td>${esc(v)}</td>`;
  if (f.kind === 'bool') {
    const pair = labels[c] || ['No', 'Yes'];
    return `<td>${esc(v ? pair[1] : pair[0])}</td>`;
  }
  if (f.kind === 'ref') {
    const row = store.get(f.target, v);
    return `<td>${row ? `<a href="/${f.target}/${row.id}">${esc(store.label(f.target, row))}</a>` : '—'}</td>`;
  }
  return `<td>${esc(v)}</td>`;
};

export function listView(graph, store, entity, fields, rows, ctx) {
  const ov = graph.override?.[`${entity}.list`] || {};
  const cols = ov.columns || fields.map((f) => f.name);
  const actions = ov.rowActions ?? ['edit', 'delete'];
  const doneField = fields.find((f) => f.kind === 'bool');

  const filters = (ov.filters || []).map((f) => {
    const field = store.field(entity, f.field);
    let options = f.options;
    if (!options && field?.kind === 'ref') {
      options = [{ label: 'All' }, ...store.list(field.target, {}).map((r) => ({ label: store.label(field.target, r), eq: r.id }))];
    }
    if (!options && field?.kind === 'enum') {
      options = [{ label: 'All' }, ...field.options.map((o) => ({ label: label(o), eq: o }))];
    }
    const links = options.map((o) => {
      const active = String(ctx.where[f.field] ?? '') === String(o.eq ?? '');
      const href = o.eq === undefined ? `/${entity}` : `/${entity}?${f.field}=${encodeURIComponent(o.eq)}`;
      return `<a class="btn" href="${href}"${active ? ' aria-current="true"' : ''}>${esc(o.label)}</a>`;
    }).join(' ');
    return `<div class="card"><strong>${esc(f.name || label(f.field))}</strong><div>${links}</div></div>`;
  }).join('');

  const searchBox = (ov.search || []).length ? `<form class="card" method="get" action="/${entity}">
    <label for="q">Search</label>
    <input type="text" id="q" name="q" value="${esc(ctx.q)}" placeholder="Search ${esc(entity.toLowerCase())}s">
    <p><button type="submit">Search</button></p></form>` : '';

  const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('') + (actions.length ? '<th>Actions</th>' : '');
  const body = rows.map((r) => {
    const cells = cols.map((c) => cell(store, fields, r, c, ov.labels || {})).join('');
    const btns = actions.map((a) => {
      if (a === 'view') return `<a class="btn" href="/${entity}/${r.id}">Open</a>`;
      if (a === 'edit') return `<a class="btn" href="/${entity}/${r.id}/edit">Edit</a>`;
      if (a === 'delete') return `<form class="inline" method="post" action="/${entity}/${r.id}/delete"><button type="submit">Delete</button></form>`;
      const act = (graph.actions || []).find((x) => x.name === a);
      const toggled = act?.do?.find((s) => s.block === 'db.toggle');
      const caption = toggled && r[toggled.field] ? (act.altTitle || act.title || label(a)) : (act?.title || label(a));
      return `<form class="inline" method="post" action="/${entity}/${r.id}/action/${a}"><button type="submit">${esc(caption)}</button></form>`;
    }).join(' ');
    const isDone = doneField && r[doneField.name] && ov.strikeDone !== false && doneField.name === 'done';
    return `<tr class="${isDone ? 'done' : ''}">${cells}${actions.length ? `<td>${btns}</td>` : ''}</tr>`;
  }).join('');

  const title = ov.title || plural(label(entity));
  return page(graph, {
    title, flash: ctx.flash,
    body: `<h2>${esc(title)}</h2>${searchBox}${filters}
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${rows.length} item(s)</p>
      ${ov.create === false ? '' : `<p><a class="btn" href="/${entity}/new">Add ${esc(label(entity))}</a></p>`}`,
  });
}

export function formFields(store, entity, fields, row, only) {
  return fields.filter((f) => (only ? only.includes(f.name) : true)).map((f) => {
    const id = `f_${f.name}`, v = row?.[f.name];
    if (f.kind === 'time') return '';
    let input;
    if (f.kind === 'longtext') input = `<textarea id="${id}" name="${f.name}" rows="4"${f.required ? ' required' : ''}>${esc(v)}</textarea>`;
    else if (f.kind === 'bool') input = `<input type="checkbox" id="${id}" name="${f.name}"${v ? ' checked' : ''}>`;
    else if (f.kind === 'enum') input = `<select id="${id}" name="${f.name}">` +
      f.options.map((o) => `<option${String(v) === o ? ' selected' : ''}>${esc(o)}</option>`).join('') + '</select>';
    else if (f.kind === 'ref') input = `<select id="${id}" name="${f.name}"><option value="">—</option>` +
      store.list(f.target, {}).map((r) =>
        `<option value="${r.id}"${String(v) === String(r.id) ? ' selected' : ''}>${esc(store.label(f.target, r))}</option>`).join('') + '</select>';
    else if (f.kind === 'int') input = `<input type="number" id="${id}" name="${f.name}" value="${esc(v)}"${f.required ? ' required' : ''}>`;
    else input = `<input type="text" id="${id}" name="${f.name}" value="${esc(v)}"${f.required ? ' required' : ''}>`;
    return `<label for="${id}">${esc(label(f.name))}${f.required ? ' *' : ''}</label>${input}`;
  }).join('');
}

export function formView(graph, store, entity, fields, row, mode, errors = []) {
  const ov = graph.override?.[`${entity}.form`] || {};
  const action = mode === 'new' ? `/${entity}` : `/${entity}/${row.id}`;
  const title = ov.title || (mode === 'new' ? `Add ${label(entity)}` : `Edit ${label(entity)}`);
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${
        errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  return page(graph, {
    title,
    body: `<h2>${esc(title)}</h2>${problems}${ov.intro ? `<p>${esc(ov.intro)}</p>` : ''}
      <form class="card" method="post" action="${action}">${formFields(store, entity, fields, row, ov.fields)}
      <p><button type="submit">${esc(ov.submit || (mode === 'new' ? 'Submit' : 'Save'))}</button>
      <a class="btn" href="/${entity}">Cancel</a></p></form>`,
  });
}

export function detailView(graph, store, entity, fields, row, flash) {
  const ov = graph.override?.[`${entity}.detail`] || {};
  const rows = fields.map((f) => {
    let v = row[f.name];
    if (f.kind === 'bool') { const pair = (ov.labels || {})[f.name] || ['No', 'Yes']; v = v ? pair[1] : pair[0]; }
    if (f.kind === 'ref') { const r = store.get(f.target, v); v = r ? store.label(f.target, r) : '—'; }
    return `<tr><th>${esc(label(f.name))}</th><td>${esc(v)}</td></tr>`;
  }).join('');

  const related = (ov.related || []).map((rel) => {
    const kids = store.list(rel.entity, { where: { [rel.via]: row.id }, sort: { field: 'id', dir: 'asc' } });
    const kidFields = store.fields[rel.entity];
    const show = rel.columns || kidFields.filter((f) => f.name !== rel.via).map((f) => f.name);
    const body = kids.map((k) => `<tr>${show.map((c) => cell(store, kidFields, k, c)).join('')}</tr>`).join('');
    const form = rel.form === false ? '' : `<form class="card" method="post" action="/${entity}/${row.id}/add/${rel.entity}">
      ${formFields(store, rel.entity, kidFields.filter((f) => f.name !== rel.via), {}, rel.form === true ? null : rel.form)}
      <p><button type="submit">${esc(rel.submit || `Add ${label(rel.entity)}`)}</button></p></form>`;
    return `<h3>${esc(rel.title || plural(label(rel.entity)))}</h3>
      <table><thead><tr>${show.map((c) => `<th>${esc(label(c))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${kids.length} item(s)</p>${form}`;
  }).join('');

  return page(graph, {
    title: `${label(entity)} ${store.label(entity, row)}`, flash,
    body: `<h2>${esc(store.label(entity, row))}</h2><table>${rows}</table>
      <p><a class="btn" href="/${entity}/${row.id}/edit">Edit</a> <a class="btn" href="/${entity}">Back</a></p>${related}`,
  });
}

export function dashboardView(graph, store, dash, flash) {
  const cards = (dash.cards || []).map((c) => {
    const [row] = store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: c.where || {} });
    const v = row?.v ?? 0;
    return `<div class="metric"><b>${esc(typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v)}</b>${esc(c.title)}</div>`;
  }).join('');
  const tables = (dash.tables || []).map((t) => {
    const rows = store.aggregate(t.entity, t);
    const groupField = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    const head = (t.groupBy ? `<th>${esc(t.groupTitle || label(t.groupBy))}</th>` : '') +
      (t.metrics || []).map((m) => `<th>${esc(m.title ?? label(m.as))}</th>`).join('');
    const body = rows.map((r) => {
      let g = r.grp;
      if (groupField?.kind === 'ref') g = store.label(groupField.target, store.get(groupField.target, g)) || null;
      return `<tr>${t.groupBy ? `<td>${esc(g ?? '—')}</td>` : ''}${
        (t.metrics ?? []).map((m) => `<td>${esc(r[m.as])}</td>`).join('')}</tr>`;
    }).join('');
    return `<h3>${esc(t.title)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
  return page(graph, {
    title: dash.title, flash,
    body: `<h2>${esc(dash.title)}</h2>${dash.intro ? `<p>${esc(dash.intro)}</p>` : ''}
      <div class="metrics">${cards}</div>${tables}`,
  });
}

export function staticPage(graph, p, flash) {
  const body = (p.body || []).map((t) => `<p>${esc(t)}</p>`).join('');
  const links = (p.links || []).map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(' ');
  const buttons = (p.actions || []).map((a) => {
    const act = (graph.actions || []).find((x) => x.name === a);
    return `<form class="inline" method="post" action="/action/${esc(a)}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
  }).join(' ');
  return page(graph, { title: p.title, flash,
    body: `<h2>${esc(p.heading || p.title)}</h2><div class="card">${body}${buttons ? `<p>${buttons}</p>` : ''}</div><p>${links}</p>` });
}

export function errorPage(graph, errors) {
  return page(graph || { app: 'invalid graph', data: {} }, {
    title: 'Graph is invalid',
    body: `<h2>Graph is invalid</h2><pre class="card">${esc(errors)}</pre>`,
  });
}
