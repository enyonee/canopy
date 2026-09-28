// `/override` shapes the screens /views: auto derives (columns, search,
// filters, sort, actions, related child tables…), all checked field-by-field
// and action-by-action against the entity the key names.
import { checkWidget } from './util.mjs';

const VIEWS = ['list', 'form', 'detail'];

export const NODES = ['override'];

// A child table on a detail screen: its own entity/via/columns/rowActions/fill,
// split out so check() stays under the function-size budget.
function checkRelated(graph, entity, key, ov, h) {
  const { err, checkEntity, checkField, fields, stateNames } = h;
  (ov.related || []).forEach((rel, i) => {
    const p = `/override/${key}/related/${i}`;
    if (!checkEntity(rel.entity, `${p}/entity`)) return;
    if (!rel.via) return err(`${p}/via`, 'related section needs "via" (the ref field on the child)');
    if (checkField(rel.entity, rel.via, `${p}/via`)) {
      const f = fields[rel.entity][rel.via];
      if (f.kind !== 'ref') err(`${p}/via`, `"${rel.via}" is ${f.kind}, not a reference`, `declare it as "ref:${entity}"`);
      else if (f.target !== entity) err(`${p}/via`, `"${rel.via}" points at ${f.target}, not ${entity}`);
    }
    (rel.columns || []).forEach((c) => c === 'id' || checkField(rel.entity, c, `${p}/columns`, { secret: true }));
    (rel.rowActions || []).forEach((a, k) => {
      if (['edit', 'delete', 'view'].includes(a) || (typeof a === 'string' && a.startsWith('go:') && stateNames(rel.entity).includes(a.slice(3)))) return;
      if (!(graph.actions || []).some((x) => x.name === a && x.in === rel.entity)) err(`${p}/rowActions/${k}`, `unknown action "${a}" on ${rel.entity}`, 'built-in: view, edit, delete, go:<transition>, or an action with "in" set to this entity');
    });
    Object.keys(rel.fill || {}).forEach((c) => checkField(rel.entity, c, `${p}/fill/${c}`, { stored: true }));
    // "@row.*" in a related fill is the parent row (item 3), not the child being created.
    h.checkValues(rel.fill || {}, { row: entity }, `${p}/fill`);
  });
}

// A form's byRole entirely replaces the default field list for that role (item 10) —
// both rendering and writability, so it is checked exactly like the default "fields".
function checkByRole(entity, key, ov, h) {
  const { err, checkField, roleNames } = h;
  for (const [role, spec] of Object.entries(ov.byRole || {})) {
    const rp = `/override/${key}/byRole/${role}`;
    if (!roleNames.includes(role)) err(rp, `"${role}" is not a role`, `roles: ${roleNames.join(', ')}`);
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.fields)) { err(rp, 'a byRole entry needs "fields": the field list for that role'); continue; }
    spec.fields.forEach((f) => checkField(entity, f, `${rp}/fields`, { stored: true }));
  }
}

export function check(graph, h) {
  const { err, checkEntity, checkField, checkWhere, fields, stateNames, actionNames } = h;
  for (const [key, ov] of Object.entries(graph.override || {})) {
    const [entity, kind] = key.split('.');
    if (!checkEntity(entity, `/override/${key}`)) continue;
    if (!VIEWS.includes(kind)) { err(`/override/${key}`, `unknown view "${kind}"`, `views are: ${VIEWS.join(', ')}`); continue; }
    if (kind === 'form' && ov.byRole) checkByRole(entity, key, ov, h);
    (ov.columns || []).forEach((f) => f === 'id' || checkField(entity, f, `/override/${key}/columns`, { secret: true }));
    (ov.search || []).forEach((f) => checkField(entity, f, `/override/${key}/search`, { stored: true }));
    (ov.fields || []).forEach((f) => checkField(entity, f, `/override/${key}/fields`, { stored: kind === 'form', secret: kind === 'detail' }));
    (ov.actions || []).forEach((a, i) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/override/${key}/actions/${i}`, `unknown action "${a}"`, `declared in /actions: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in !== entity) err(`/override/${key}/actions/${i}`, `action "${a}" is not bound to ${entity}`, `it needs "in": "${entity}"`);
    });
    if (ov.sort) checkField(entity, ov.sort.field, `/override/${key}/sort/field`);
    if (ov.pageSize !== undefined && !(Number.isInteger(ov.pageSize) && ov.pageSize > 0)) err(`/override/${key}/pageSize`, 'pageSize must be a positive integer');
    Object.keys(ov.fill || {}).forEach((f) => checkField(entity, f, `/override/${key}/fill/${f}`, { stored: true }));
    checkWhere(entity, ov.where, `/override/${key}/where`);
    Object.keys(ov.labels || {}).forEach((f) => checkField(entity, f, `/override/${key}/labels/${f}`));
    (ov.filters || []).forEach((flt, i) => {
      if (!flt.field) return err(`/override/${key}/filters/${i}`, 'filter needs a "field"');
      if (!checkField(entity, flt.field, `/override/${key}/filters/${i}/field`)) return;
      const f = fields[entity][flt.field];
      if (flt.range) {
        if (!f.type.numeric && !f.type.temporal) err(`/override/${key}/filters/${i}`, `a range filter needs a date, time, int or money field; "${flt.field}" is ${f.kind}`);
        return;
      }
      if (!flt.options && !['ref', 'enum', 'bool'].includes(f.kind))
        err(`/override/${key}/filters/${i}`, `filter on "${flt.field}" needs "options"`,
          'options are derived automatically only for ref, enum and bool fields');
    });
    (ov.rowActions || []).forEach((a, i) => {
      if (['edit', 'delete', 'view'].includes(a)) return;
      if (typeof a === 'string' && a.startsWith('go:')) {
        if (!stateNames(entity).includes(a.slice(3)))
          err(`/override/${key}/rowActions/${i}`, `unknown transition "${a.slice(3)}" on ${entity}`, `declared in /states/${entity}: ${stateNames(entity).join(', ') || '(none)'}`);
        return;
      }
      if (!actionNames.includes(a))
        err(`/override/${key}/rowActions/${i}`, `unknown action "${a}"`,
          `built-in: view, edit, delete, go:<transition>; declared in /actions: ${actionNames.join(', ') || '(none)'}`);
    });
    checkRelated(graph, entity, key, ov, h);
    if (kind === 'detail' && ov.widget) checkWidget(h, ov.widget, `/override/${key}/widget`, entity);
  }
}
