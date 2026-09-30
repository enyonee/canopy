// The detail view: the field table, edit/action buttons, transition forms,
// and related child tables (each with its own inline add-form).
import { esc, label, plural, anyone, noPre, loaded, refPairs, page, fmt, cell, rowButtons, transitionsFor, enctype, widgetBlock, rowJSON, mayRunAction } from '../render.mjs';
import { formFields, inputTargets } from './form.mjs';

const actionOf = (graph, name) => (graph.actions || []).find((x) => x.name === name);
const shownFields = (fields, ov) => fields.filter((f) => !f.type.secret).filter((f) => !ov.fields || ov.fields.includes(f.name));
const relatedShow = (store, rel) => rel.columns || store.fields[rel.entity].filter((f) => f.name !== rel.via && !f.type.secret).map((f) => f.name);
// A child table is a read of another entity: the viewer needs "view" on it, not only
// on the parent row it hangs under.
export const relatedOf = (ov, vc) => (ov.related || []).filter((rel) => vc.can(rel.entity, 'view'));
const relatedForm = (store, rel) => ({ entity: rel.entity, fields: store.fields[rel.entity].filter((f) => f.name !== rel.via),
  only: rel.form === true ? null : rel.form, skip: Object.keys(rel.fill || {}) });

// Row actions with declared fields are offered as forms of their own, where mayRunAction agrees (item 19).
const formActions = (graph, entity, row, vc, names) => names.map((a) => actionOf(graph, a)).filter((act) => act?.fields?.length && mayRunAction(vc, entity, act, row));

// What this detail page needs loaded before it renders (S3c): the label of every reference cell of the
// row and of its related tables (`kids`: rows by related section), and the options of every reference
// input of the forms it offers — transitions, actions, related adds.
export function detailNeeds(graph, store, entity, fields, row, vc, kids) {
  const ov = graph.override?.[`${entity}.detail`] || {};
  const pairs = refPairs(fields, shownFields(fields, ov).map((f) => f.name), [row]);
  for (const [rel, rows] of kids) pairs.push(...refPairs(store.fields[rel.entity], relatedShow(store, rel), rows));
  const forms = [...transitionsFor(graph, entity, row, vc).filter((t) => t.fields?.length).map((t) => ({ entity, fields, only: t.fields })),
    ...formActions(graph, entity, row, vc, ov.actions || []).map((act) => ({ entity, fields, only: act.fields })),
    ...relatedOf(ov, vc).filter((rel) => rel.form !== false && vc.can(rel.entity, 'create')).map((rel) => relatedForm(store, rel))];
  return { pairs, targets: forms.flatMap((x) => inputTargets(store, x.entity, x.fields, x.only, x.skip)) };
}

function transitionForms(graph, store, entity, fields, row, vc, pre) {
  return transitionsFor(graph, entity, row, vc).map((t) =>
    `<form class="card inline-block" method="post" action="/${entity}/${row.id}/go/${t.name}">
      ${t.fields?.length ? formFields(store, entity, fields, row, t.fields, { pre }) : ''}
      <p><button type="submit">${esc(t.title || label(t.name))}</button></p></form>`).join('');
}

function actionForms(graph, store, entity, fields, row, vc, names, pre) {
  return formActions(graph, entity, row, vc, names)
    .map((act) => `<form class="card inline-block" method="post" action="/${entity}/${row.id}/action/${act.name}">
      ${formFields(store, entity, fields, row, act.fields, { pre })}
      <p><button type="submit">${esc(act.title || label(act.name))}</button></p></form>`).join('');
}

export function detailView(graph, store, entity, fields, row, flash, vc = anyone, pre = noPre) {
  const ov = graph.override?.[`${entity}.detail`] || {};
  const rows = shownFields(fields, ov).map((f) =>
    `<tr><th>${esc(label(f.name))}</th><td>${fmt(store, entity, f, row, ov.labels || {}, vc, pre)}</td></tr>`).join('');

  const related = relatedOf(ov, vc).map((rel) => {
    const kids = loaded(pre.kids, rel, `related ${rel.entity} of ${entity}`);
    const kidFields = store.fields[rel.entity];
    const show = relatedShow(store, rel);
    const body = kids.map((k) => `<tr>${show.map((c) => cell(store, rel.entity, kidFields, k, c, {}, vc, pre)).join('')}${
      rel.rowActions ? `<td>${rowButtons(graph, store, rel.entity, k, rel.rowActions, vc)}</td>` : ''}</tr>`).join('');
    const rf = relatedForm(store, rel);
    const form = rel.form === false || !vc.can(rel.entity, 'create') ? '' : `<form class="card" method="post" action="/${entity}/${row.id}/add/${rel.entity}"${enctype(kidFields)}>
      ${formFields(store, rel.entity, rf.fields, {}, rf.only, { skip: rf.skip, pre })}
      <p><button type="submit">${esc(rel.submit || `Add ${label(rel.entity)}`)}</button></p></form>`;
    return `<h3>${esc(rel.title || plural(label(rel.entity)))}</h3>
      <table><thead><tr>${show.map((c) => `<th>${esc(label(c))}</th>`).join('')}${rel.rowActions ? '<th>Actions</th>' : ''}</tr></thead><tbody>${body}</tbody></table>
      <p class="muted">${kids.length} item(s)</p>${form}`;
  }).join('');

  const buttons = [
    vc.can(entity, 'edit', row) ? `<a class="btn" href="/${entity}/${row.id}/edit">Edit</a>` : '',
    ...(ov.actions || []).filter((a) => {
      const act = actionOf(graph, a);
      if (act?.fields?.length) return false; // rendered as its own form below instead
      return act ? mayRunAction(vc, entity, act, row) : vc.can(entity, `do:${a}`, row);
    }).map((a) => {
      const act = actionOf(graph, a);
      return `<form class="inline" method="post" action="/${entity}/${row.id}/action/${a}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
    }),
    `<a class="btn" href="/${entity}">Back</a>`,
  ].filter(Boolean).join(' ');

  return page(graph, {
    title: `${label(entity)} ${store.label(entity, row)}`, flash, vc,
    body: `<h2>${esc(store.label(entity, row))}</h2><table>${rows}</table>
      ${ov.widget ? widgetBlock(ov.widget, { row: rowJSON(store, entity, fields, row, vc) }) : ''}
      <p>${buttons}</p>${transitionForms(graph, store, entity, fields, row, vc, pre)}${actionForms(graph, store, entity, fields, row, vc, ov.actions || [], pre)}${related}`,
  });
}
