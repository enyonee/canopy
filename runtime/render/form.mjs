// The create/edit form: one input per stored, visible field, in declared or
// natural order. Shared by Entity.form, the related add-form (detail.mjs) and
// /register (pages.mjs).
import { isStored } from '../spec.mjs';
import { esc, label, anyone, page, enctype } from '../render.mjs';

export function formFields(store, entity, fields, row, only, { skip = [] } = {}) {
  const statusField = store.graph?.states?.[entity]?.field;
  return fields.filter(isStored).filter((f) => !skip.includes(f.name) && (f.name !== statusField || only?.includes(f.name)))
    .filter((f) => (only ? only.includes(f.name) : true)).filter((f) => f.type.input).map((f) =>
      `<label for="f_${f.name}">${esc(label(f.name))}${f.required ? ' *' : ''}</label>${f.type.input(f, row?.[f.name], { esc, store, entity, row })}`).join('');
}

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
