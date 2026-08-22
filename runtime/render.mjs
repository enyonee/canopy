// Scaffold renderer. Not a product UI — an admin-grade surface derived from the
// schema so a browser can reach the backend. Colours come from /theme, never CSS.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const label = (name) => name.replace(/([A-Z])/g, ' $1').trim().replace(/^./, (c) => c.toUpperCase());

export function page(graph, { title, body }) {
  const bg = graph.theme?.background || 'white';
  const accent = graph.theme?.accent || 'navy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(graph.app)}</title><style>
:root { --bg: ${accent === 'indigo' ? 'lavender' : bg}; --accent: ${accent}; }
body { background: ${bg}; color: #1a1a2e; font: 16px/1.5 system-ui, sans-serif; margin: 0; }
header { background: ${accent}; color: white; padding: 16px 24px; }
header h1 { margin: 0 0 8px; font-size: 20px; }
nav a { color: white; margin-right: 16px; text-decoration: underline; }
main { max-width: 900px; margin: 24px auto; padding: 0 16px; }
.card { background: white; border: 2px solid ${accent}; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
table { width: 100%; border-collapse: collapse; background: white; border: 2px solid ${accent}; }
th { background: ${accent}; color: white; text-align: left; padding: 8px; }
td { padding: 8px; border-top: 1px solid #ddd; vertical-align: top; }
tr.done td { text-decoration: line-through; opacity: .65; }
button, .btn { background: ${accent}; color: white; border: 0; border-radius: 6px;
  padding: 6px 12px; font-size: 14px; cursor: pointer; text-decoration: none; display: inline-block; }
label { display: block; margin: 12px 0 4px; font-weight: 600; color: ${accent}; }
input[type=text], input[type=number], textarea, select {
  width: 100%; padding: 8px; border: 1px solid ${accent}; border-radius: 6px; font: inherit; box-sizing: border-box; }
form.inline { display: inline; }
.muted { color: #555; font-size: 14px; }
</style></head><body>
<header><h1>${esc(graph.app)}</h1><nav>${navLinks(graph)}</nav></header>
<main>${body}</main></body></html>`;
}

function navLinks(graph) {
  const out = [];
  for (const entity of Object.keys(graph.data)) {
    const ov = graph.override?.[`${entity}.list`] || {};
    out.push(`<a href="/${entity}">${esc(ov.title || `All ${label(entity)}s`)}</a>`);
    for (const f of ov.filters || []) {
      for (const opt of f.options) {
        if (opt.eq === undefined) continue;
        out.push(`<a href="/${entity}?${encodeURIComponent(f.field)}=${encodeURIComponent(String(opt.eq))}">${esc(opt.label)}</a>`);
      }
    }
    out.push(`<a href="/${entity}/new">Add ${esc(label(entity))}</a>`);
  }
  return out.join('');
}

export function listView(graph, entity, fields, rows, ctx) {
  const ov = graph.override?.[`${entity}.list`] || {};
  const cols = ov.columns || fields.map((f) => f.name);
  const actions = ov.rowActions || ['edit', 'delete'];
  const doneField = fields.find((f) => f.kind === 'bool');

  const filters = (ov.filters || []).map((f) => {
    const links = f.options.map((o) => {
      const active = String(ctx.where[f.field] ?? '') === String(o.eq ?? '');
      const href = o.eq === undefined ? `/${entity}` : `/${entity}?${f.field}=${o.eq}`;
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
    const cells = cols.map((c) => {
      const f = fields.find((x) => x.name === c);
      const v = r[c];
      if (f?.kind === 'bool') return `<td>${v ? 'Completed' : 'Not completed'}</td>`;
      return `<td>${esc(v)}</td>`;
    }).join('');
    const btns = actions.map((a) => {
      if (a === 'edit') return `<a class="btn" href="/${entity}/${r.id}/edit">Edit</a>`;
      if (a === 'delete') return `<form class="inline" method="post" action="/${entity}/${r.id}/delete"><button type="submit">Delete</button></form>`;
      const act = (graph.actions || []).find((x) => x.name === a);
      const toggled = act?.do?.find((s) => s.block === 'db.toggle');
      const caption = toggled && r[toggled.field] ? (act.altTitle || act.title || label(a)) : (act?.title || label(a));
      return `<form class="inline" method="post" action="/${entity}/${r.id}/action/${a}"><button type="submit">${esc(caption)}</button></form>`;
    }).join(' ');
    const isDone = doneField && r[doneField.name];
    return `<tr class="${isDone ? 'done' : ''}"><td style="display:none">${r.id}</td>`.replace('<td style="display:none">' + r.id + '</td>', '')
      + cells + (actions.length ? `<td>${btns}</td>` : '') + '</tr>';
  }).join('');

  return page(graph, {
    title: ov.title || `${label(entity)}s`,
    body: `<h2>${esc(ov.title || `${label(entity)}s`)}</h2>${searchBox}${filters}
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${rows.length} item(s)</p>
      <p><a class="btn" href="/${entity}/new">Add ${esc(label(entity))}</a></p>`,
  });
}

export function formView(graph, entity, fields, row, mode) {
  const action = mode === 'new' ? `/${entity}` : `/${entity}/${row.id}`;
  const title = mode === 'new' ? `Add ${label(entity)}` : `Edit ${label(entity)}`;
  const inputs = fields.map((f) => {
    const id = `f_${f.name}`, v = row?.[f.name];
    let input;
    if (f.kind === 'longtext') input = `<textarea id="${id}" name="${f.name}" rows="4">${esc(v)}</textarea>`;
    else if (f.kind === 'bool') input = `<input type="checkbox" id="${id}" name="${f.name}"${v ? ' checked' : ''}>`;
    else if (f.kind === 'enum') input = `<select id="${id}" name="${f.name}">` +
      f.options.map((o) => `<option${String(v) === o ? ' selected' : ''}>${esc(o)}</option>`).join('') + '</select>';
    else if (f.kind === 'int') input = `<input type="number" id="${id}" name="${f.name}" value="${esc(v)}">`;
    else if (f.kind === 'time') return '';
    else input = `<input type="text" id="${id}" name="${f.name}" value="${esc(v)}"${f.required ? ' required' : ''}>`;
    return `<label for="${id}">${esc(label(f.name))}</label>${input}`;
  }).join('');
  return page(graph, {
    title,
    body: `<h2>${esc(title)}</h2><form class="card" method="post" action="${action}">${inputs}
      <p><button type="submit">${mode === 'new' ? 'Add' : 'Save'}</button>
      <a class="btn" href="/${entity}">Cancel</a></p></form>`,
  });
}

export function detailView(graph, entity, fields, row) {
  const rows = fields.map((f) => `<tr><th>${esc(label(f.name))}</th><td>${
    f.kind === 'bool' ? (row[f.name] ? 'Completed' : 'Not completed') : esc(row[f.name])}</td></tr>`).join('');
  return page(graph, {
    title: `${label(entity)} #${row.id}`,
    body: `<h2>${esc(label(entity))} #${row.id}</h2><table>${rows}</table>
      <p><a class="btn" href="/${entity}/${row.id}/edit">Edit</a> <a class="btn" href="/${entity}">Back</a></p>`,
  });
}

export function errorPage(graph, errors) {
  return page(graph || { app: 'invalid graph', data: {} }, {
    title: 'Graph is invalid',
    body: `<h2>Graph is invalid</h2><pre class="card">${esc(errors)}</pre>`,
  });
}
