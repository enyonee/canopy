// The graph (app.json) and its OpenAPI contract → the app model the generated front end runs on: every screen,
// field, action, transition, list, dashboard and page, with its permission keys. Pure and deterministic: the same
// two documents give the same model, key order included. Whatever the format does not say is not invented here.
import { title, plural, parseSpec, labelField, ruleBounds, uniqueFields } from './graph.mjs';

const schemaOf = (openapi, name) => openapi?.components?.schemas?.[name] || null;

// The JSON type a value has in the contract; the graph's kind when the contract says nothing.
function jsonType(prop, kind) {
  const t = Array.isArray(prop?.type) ? prop.type.find((x) => x !== 'null') : prop?.type;
  if (t) return t;
  if (kind === 'money') return 'number';
  if (kind === 'bool') return 'boolean';
  if (kind === 'int') return 'integer';
  return 'string';
}

function fieldModel(entity, spec, openapi, rules) {
  const row = schemaOf(openapi, entity);
  const prop = row?.properties?.[spec.name];
  const kind = prop?.['x-canopy-kind'] || spec.kind;
  const bounds = ruleBounds(rules)[spec.name] || [];
  const f = {
    name: spec.name, label: title(spec.name), kind, type: jsonType(prop, kind),
    required: spec.required, derived: Boolean(spec.derived), secret: kind === 'password',
    default: spec.default, options: prop?.enum || spec.options || null, target: prop?.['x-canopy-ref'] || spec.target || null,
    bounds, unique: uniqueFields(rules).includes(spec.name),
  };
  // Kinds whose value range the kind itself fixes: a percent is 0–100 (the shop's plugin kind).
  if (kind === 'percent') f.bounds = [{ op: '>=', value: 0, message: `${f.label} must be between 0 and 100` }, { op: '<=', value: 100, message: `${f.label} must be between 0 and 100` }, ...bounds];
  return f;
}

const stored = (f) => !f.derived && f.kind !== 'time';

function listModel(graph, entity, fields, ov = {}) {
  return {
    title: ov.title || plural(title(entity)),
    intro: ov.intro || null,
    hidden: Boolean(ov.hidden),
    create: ov.create !== false,
    createTitle: ov.createTitle || `Add ${title(entity).toLowerCase()}`,
    columns: ov.columns || fields.filter((f) => !f.secret).map((f) => f.name),
    search: ov.search || [],
    filters: (ov.filters || []).map((x) => ({ name: x.name || title(x.field), field: x.field, range: Boolean(x.range) })),
    sort: ov.sort || null,
    pageSize: ov.pageSize || 50,
    rowActions: ov.rowActions || ['edit', 'delete'],
    labels: ov.labels || {},
  };
}

function formModel(entity, fields, ov = {}, statusField) {
  const writable = fields.filter((f) => stored(f) && f.name !== statusField && !['file', 'image'].includes(f.kind));
  return {
    title: ov.title || null, intro: ov.intro || null, submit: ov.submit || null,
    fields: (ov.fields || writable.map((f) => f.name)).filter((n) => writable.some((f) => f.name === n) || n === statusField),
    byRole: Object.fromEntries(Object.entries(ov.byRole || {}).map(([r, v]) => [r, v.fields])),
    fill: Object.keys(ov.fill || {}),
    after: ov.after || null, afterEdit: ov.afterEdit || null,
  };
}

function detailModel(graph, entity, fields, ov = {}) {
  return {
    fields: ov.fields || fields.filter((f) => !f.secret).map((f) => f.name),
    actions: ov.actions || [],
    labels: ov.labels || {},
    private: ov.private || {},
    related: (ov.related || []).map((r) => {
      const childList = graph.override?.[`${r.entity}.list`] || {};
      return {
        entity: r.entity, via: r.via, title: r.title || plural(title(r.entity)),
        columns: r.columns || childList.columns || null,
        form: r.form === false ? false : Array.isArray(r.form) ? r.form : null,
        submit: r.submit || `Add ${title(r.entity).toLowerCase()}`,
        rowActions: r.rowActions || ['edit', 'delete'],
      };
    }),
  };
}

function transitionsOf(graph, entity) {
  const st = graph.states?.[entity];
  if (!st) return null;
  return {
    field: st.field,
    transitions: st.transitions.map((t) => ({
      name: t.name, title: t.title || title(t.name), from: t.from === undefined || t.from === '*' ? null : [].concat(t.from),
      to: t.to, fields: t.fields || [], by: t.by || null, after: t.after || null, destructive: /cancel|reject|delete|refund/i.test(t.name),
    })),
  };
}

function actionsOf(graph, entity) {
  return (graph.actions || []).filter((a) => a.in === entity).map((a) => ({
    name: a.name, title: a.title || title(a.name), by: a.by || null, after: a.after || null, fields: a.fields || [],
  }));
}

function entityModel(graph, openapi, entity) {
  const rules = graph.rules?.[entity] || [];
  const specs = Object.entries(graph.data[entity]).map(([n, s]) => parseSpec(n, s));
  const fields = specs.map((s) => fieldModel(entity, s, openapi, rules));
  const states = transitionsOf(graph, entity);
  const ov = (k) => graph.override?.[`${entity}.${k}`];
  return {
    name: entity, label: title(entity), plural: plural(title(entity)), labelField: labelField(specs),
    fields, states,
    actions: actionsOf(graph, entity),
    list: listModel(graph, entity, fields, ov('list')),
    form: formModel(entity, fields, ov('form'), states?.field),
    detail: detailModel(graph, entity, fields, ov('detail')),
  };
}

function rolesModel(graph) {
  const r = graph.roles;
  if (!r) return null;
  const roleField = parseSpec(r.role, graph.data[r.entity][r.role]);
  return {
    entity: r.entity, login: r.login, loginLabel: title(r.login), password: r.password, roleField: r.role,
    names: roleField.options || [], register: r.register || null, anonymous: r.anonymous || null,
    admins: Object.entries(r.can || {}).filter(([, v]) => v === '*').map(([k]) => k),
    // Registration asks for what has no default: a field with a default (a discount, points) is left to it.
    registerFields: Object.entries(graph.data[r.entity]).map(([n, s]) => parseSpec(n, s))
      .filter((f) => !f.derived && f.name !== r.role && f.default === null && !['file', 'image', 'time'].includes(f.kind)).map((f) => f.name),
    can: r.can || {},
  };
}

function dashboardModel(graph, openapi, entities, d) {
  const fieldOf = (e, n) => entities[e]?.fields.find((f) => f.name === n);
  const money = (e, field, fn) => fn !== 'count' && fieldOf(e, field)?.kind === 'money';
  const group = (e, by, unit) => { const f = fieldOf(e, by); return { field: by, kind: f?.kind || 'text', target: f?.target || null, options: f?.options || null, unit: unit || null }; };
  return {
    id: d.id, title: d.title || title(d.id), intro: d.intro || null, roles: d.roles || null, refresh: d.refresh || null,
    period: Boolean(d.period && Object.keys(d.period).length),
    cards: (d.cards || []).map((c) => ({ title: c.title, entity: c.entity, fn: c.fn || 'count', money: money(c.entity, c.field, c.fn || 'count') })),
    tables: (d.tables || []).map((t) => ({
      title: t.title, entity: t.entity, groupTitle: t.groupTitle || (t.groupBy ? title(t.groupBy) : null), group: t.groupBy ? group(t.entity, t.groupBy, t.groupUnit) : null,
      metrics: (t.metrics || []).map((m) => ({ as: m.as, title: m.title || title(m.as), money: money(t.entity, m.field, m.fn) })),
    })),
    charts: (d.charts || []).map((c) => ({
      title: c.title, entity: c.entity, type: c.type || 'bar', group: c.groupBy ? group(c.entity, c.groupBy, c.groupUnit) : null,
      money: money(c.entity, c.metric?.field, c.metric?.fn || 'count'),
    })),
  };
}

function listsModel(graph, entities) {
  return (graph.lists || []).map((l) => {
    const base = entities[l.entity].list;
    return {
      id: l.id, entity: l.entity, title: l.title || title(l.id), roles: l.roles || null, hidden: Boolean(l.hidden), intro: l.intro || null,
      columns: l.columns || base.columns, rowActions: l.rowActions || base.rowActions, create: l.create === true,
      search: l.search || [], sort: l.sort || null, createTitle: base.createTitle,
    };
  });
}

function pagesModel(graph) {
  return (graph.pages || []).map((p) => ({
    id: p.id, title: p.title || title(p.id), heading: p.heading || p.title || title(p.id), body: [].concat(p.body || []),
    links: p.links || [], actions: p.actions || [], roles: p.roles || null, sections: p.sections || [],
  }));
}

// Icons for the navigation, by what an item is called. A word that names none gets the kind's icon.
const ICONS = [
  [/product|item|catalog|stock|inventory|shop|store/i, 'package'], [/cart|basket/i, 'shopping-cart'], [/order|invoice|receipt|purchase/i, 'receipt'],
  [/user|customer|member|people|person|contact|client|team/i, 'users'], [/categor|tag|label|topic/i, 'tags'], [/sale|revenue|report|stat|analytic/i, 'chart'],
  [/task|todo|issue|ticket/i, 'check-square'], [/event|booking|calendar|schedule|appointment/i, 'calendar'], [/message|chat|comment|post|thread/i, 'message'],
  [/note|article|doc|page|blog/i, 'file-text'], [/setting|config/i, 'settings'],
];
const iconFor = (words, fallback) => ICONS.find(([re]) => words.some((w) => re.test(w)))?.[1] || fallback;

function navModel(graph, entities, lists, dashboards, pages) {
  const nav = [];
  for (const e of Object.values(entities)) {
    if (!e.list.hidden) nav.push({ kind: 'entity', to: `/${e.name}`, title: e.list.title, icon: iconFor([e.name, e.list.title], 'table'), entity: e.name, roles: null });
  }
  for (const l of lists) if (!l.hidden) nav.push({ kind: 'list', to: `/list/${l.id}`, title: l.title, icon: iconFor([l.id, l.title], 'list'), entity: l.entity, roles: l.roles });
  for (const d of dashboards) nav.push({ kind: 'dashboard', to: `/dashboard/${d.id}`, title: d.title, icon: 'chart', entity: null, roles: d.roles });
  for (const p of pages) nav.push({ kind: 'page', to: `/page/${p.id}`, title: p.title, icon: iconFor([p.id, p.title], 'file-text'), entity: null, roles: p.roles });
  // The home screen leads the menu; the rest keep the graph's order.
  const home = nav.findIndex((n) => n.to === graph.home);
  if (home > 0) nav.unshift(...nav.splice(home, 1));
  return nav;
}

/** The model of an app: what src/gen/app.ts of the generated project holds. */
export function buildModel(graph, openapi) {
  const entities = Object.fromEntries(Object.keys(graph.data).map((e) => [e, entityModel(graph, openapi, e)]));
  const lists = listsModel(graph, entities);
  const dashboards = (graph.dashboards || []).map((d) => dashboardModel(graph, openapi, entities, d));
  const pages = pagesModel(graph);
  return {
    name: graph.app || 'app',
    title: title(graph.app || 'app'),
    note: graph.note || null,
    home: graph.home || null,
    theme: { background: graph.theme?.background || null, accent: graph.theme?.accent || null },
    roles: rolesModel(graph),
    entities, lists, dashboards, pages,
    search: graph.search ? { entities: graph.search.entities, title: graph.search.title || 'Search' } : null,
    nav: navModel(graph, entities, lists, dashboards, pages),
    globalActions: (graph.actions || []).filter((a) => !a.in).map((a) => ({ name: a.name, title: a.title || title(a.name), fields: a.fields || [], by: a.by || null, after: a.after || null })),
  };
}
