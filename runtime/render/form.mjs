// The create/edit form: one input per stored, visible field, in declared or
// natural order. Shared by Entity.form, the related add-form (detail.mjs) and
// /register (pages.mjs).
import { isStored } from '../spec.mjs';
import { esc, label, anyone, noPre, page, enctype } from '../render.mjs';

// The fields a form renders, in order: stored, visible (the state field only when asked for by name),
// with an input. Shared by the renderer (formFields) and by the route that loads what they need.
function inputFields(store, entity, fields, only, skip = []) {
  const statusField = store.graph?.states?.[entity]?.field;
  return fields.filter(isStored).filter((f) => !skip.includes(f.name) && (f.name !== statusField || only?.includes(f.name)))
    .filter((f) => (only ? only.includes(f.name) : true)).filter((f) => f.type.input);
}

// The target entities whose rows those inputs offer (`ctx.options(target)`): load them first, `Store#optionsFor`.
export const inputTargets = (store, entity, fields, only, skip = []) => inputFields(store, entity, fields, only, skip).filter((f) => f.target).map((f) => f.target);

export function formFields(store, entity, fields, row, only, { skip = [], pre = noPre } = {}) {
  return inputFields(store, entity, fields, only, skip).map((f) =>
    `<label for="f_${f.name}">${esc(label(f.name))}${f.required ? ' *' : ''}</label>${f.type.input(f, row?.[f.name], { esc, options: pre.options, entity, row })}`).join('');
}

// A role's own field list (item 10) entirely replaces the default one, for both
// rendering (formView, below) and writability (routes/entity.mjs's onlyWritable call).
export const formFieldsFor = (ov, role) => ov.byRole?.[role]?.fields ?? ov.fields;

// What formView leaves out, and what it shows: the declared `fill` and the viewer's own field are not asked for.
export function formSpec(graph, entity, vc) {
  const ov = graph.override?.[`${entity}.form`] || {};
  const skip = Object.keys(ov.fill || {});
  const own = vc.ownField(entity);
  if (own) skip.push(own);
  return { ov, only: formFieldsFor(ov, vc.role), skip };
}

export function formView(graph, store, entity, fields, row, mode, errors = [], vc = anyone, flash = '', pre = noPre) {
  const { ov, only, skip } = formSpec(graph, entity, vc);
  const action = mode === 'new' ? `/${entity}` : `/${entity}/${row.id}`;
  const title = ov.title || (mode === 'new' ? `Add ${label(entity)}` : `Edit ${label(entity)}`);
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${
        errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  return page(graph, {
    title, vc, flash,
    body: `<h2>${esc(title)}</h2>${problems}${ov.intro ? `<p>${esc(ov.intro)}</p>` : ''}
      <form class="card" method="post" action="${action}"${enctype(fields)}>${formFields(store, entity, fields, row, only, { skip, pre })}
      <p><button type="submit">${esc(ov.submit || (mode === 'new' ? 'Submit' : 'Save'))}</button>
      <a class="btn" href="/${entity}">Cancel</a></p></form>`,
  });
}
