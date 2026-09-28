// The list view: filters, search, sortable/paged columns, row actions, CSV
// export link. `ctx` here is the render-time context built by the /Entity and
// /list routes (q, where, flash, vc, range, query, sort, dir, rows, total,
// page, pages) — not the HTTP request context in routes/context.mjs.
import { esc, label, plural, anyone, page, cell, rowButtons } from '../render.mjs';

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
    const cells = cols.map((c) => cell(store, entity, fields, r, c, ov.labels || {}, vc)).join('');
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
