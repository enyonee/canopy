// The detail view: the field table, edit/action buttons, transition forms,
// and related child tables (each with its own inline add-form).
import { esc, label, plural, anyone, page, fmt, cell, rowButtons, transitionsFor, enctype, widgetBlock, rowJSON, mayRunAction } from '../render.mjs';
import { formFields } from './form.mjs';

function transitionForms(graph, store, entity, fields, row, vc) {
  return transitionsFor(graph, entity, row, vc).map((t) =>
    `<form class="card inline-block" method="post" action="/${entity}/${row.id}/go/${t.name}">
      ${t.fields?.length ? formFields(store, entity, fields, row, t.fields) : ''}
      <p><button type="submit">${esc(t.title || label(t.name))}</button></p></form>`).join('');
}

// Item 19: a row action with declared "fields" gets a real input form (like a
// transition's own), not a bare button — offered only where mayRunAction agrees.
function actionForms(graph, store, entity, fields, row, vc, names) {
  return names.map((a) => (graph.actions || []).find((x) => x.name === a))
    .filter((act) => act?.fields?.length && mayRunAction(vc, entity, act, row))
    .map((act) => `<form class="card inline-block" method="post" action="/${entity}/${row.id}/action/${act.name}">
      ${formFields(store, entity, fields, row, act.fields)}
      <p><button type="submit">${esc(act.title || label(act.name))}</button></p></form>`).join('');
}

export function detailView(graph, store, entity, fields, row, flash, vc = anyone) {
  const ov = graph.override?.[`${entity}.detail`] || {};
  const rows = fields.filter((f) => !f.type.secret).filter((f) => !ov.fields || ov.fields.includes(f.name)).map((f) =>
    `<tr><th>${esc(label(f.name))}</th><td>${fmt(store, entity, f, row, ov.labels || {}, vc)}</td></tr>`).join('');

  // A child table is a read of another entity: the viewer needs "view" on it, not only
  // on the parent row it hangs under.
  const related = (ov.related || []).filter((rel) => vc.can(rel.entity, 'view')).map((rel) => {
    const kids = store.list(rel.entity, { where: { [rel.via]: row.id, ...vc.ownWhere(rel.entity) }, sort: { field: 'id', dir: 'asc' } });
    const kidFields = store.fields[rel.entity];
    const show = rel.columns || kidFields.filter((f) => f.name !== rel.via && !f.type.secret).map((f) => f.name);
    const body = kids.map((k) => `<tr>${show.map((c) => cell(store, rel.entity, kidFields, k, c, {}, vc)).join('')}${
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
    ...(ov.actions || []).filter((a) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (act?.fields?.length) return false; // rendered as its own form below instead
      return act ? mayRunAction(vc, entity, act, row) : vc.can(entity, `do:${a}`, row);
    }).map((a) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      return `<form class="inline" method="post" action="/${entity}/${row.id}/action/${a}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
    }),
    `<a class="btn" href="/${entity}">Back</a>`,
  ].filter(Boolean).join(' ');

  return page(graph, {
    title: `${label(entity)} ${store.label(entity, row)}`, flash, vc,
    body: `<h2>${esc(store.label(entity, row))}</h2><table>${rows}</table>
      ${ov.widget ? widgetBlock(ov.widget, { row: rowJSON(store, entity, fields, row, vc) }) : ''}
      <p>${buttons}</p>${transitionForms(graph, store, entity, fields, row, vc)}${actionForms(graph, store, entity, fields, row, vc, ov.actions || [])}${related}`,
  });
}
