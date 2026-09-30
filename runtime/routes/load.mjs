// The load phase of a page (S3c). A view (runtime/render/*) formats what it is given and asks the store
// nothing; this module is where a route first asks for everything the page will read, in a batch:
//   - the row sets the page embeds (a detail's related tables, a page's saved lists, a dashboard's aggregates),
//   - the labels of every reference cell on it, ONE `labelsFor` query per target entity,
//   - the rows of every select a form offers, one `optionsFor` read per target,
//   - the parents an ownership check reads (`vc.prime`), one query per one-hop path.
// Each `…Pre` returns the `pre` object the view takes; the `render…` helpers load, then call the view.
import { prefetched, refPairs, columnsOf } from '../render.mjs';
import { listNeeds } from '../render/list.mjs';
import { formView, formSpec, inputTargets } from '../render/form.mjs';
import { detailView, detailNeeds, relatedOf } from '../render/detail.mjs';
import { sectionList, sectionForm } from '../render/pages.mjs';

// A list page: the rows of one page, its reference cells and its reference filters.
export async function listPre({ store, vc }, entity, fields, ov, rows) {
  await vc.prime(entity, rows);
  const { pairs, targets } = listNeeds(store, entity, fields, ov, rows);
  return prefetched(await store.labelsFor(pairs), await store.optionsFor(targets));
}

// The options of the reference inputs of a form: the fields formView shows for this viewer.
export async function formPre({ graph, store, vc }, entity, fields) {
  const { only, skip } = formSpec(graph, entity, vc);
  return prefetched(await store.labelsFor([]), await store.optionsFor(inputTargets(store, entity, fields, only, skip)));
}

export const renderForm = async (ctx, entity, fields, row, mode, errors = [], flash = '') =>
  formView(ctx.graph, ctx.store, entity, fields, row, mode, errors, ctx.vc, flash, await formPre(ctx, entity, fields));

// A detail page: the row, each related table the viewer may see (read with the viewer's own scope), the
// labels of all their reference cells and the options of every form the page offers.
export async function detailPre(ctx, entity, fields, row) {
  const { graph, store, vc } = ctx;
  await vc.prime(entity, [row]);
  const kids = new Map();
  for (const rel of relatedOf(graph.override?.[`${entity}.detail`] || {}, vc)) {
    const rows = await store.list(rel.entity, { where: { [rel.via]: row.id, ...await vc.ownWhere(rel.entity) }, sort: { field: 'id', dir: 'asc' } });
    await vc.prime(rel.entity, rows);
    kids.set(rel, rows);
  }
  const { pairs, targets } = detailNeeds(graph, store, entity, fields, row, vc, kids);
  return prefetched(await store.labelsFor(pairs), await store.optionsFor(targets), { kids });
}

export const renderDetail = async (ctx, entity, fields, row, flash) =>
  detailView(ctx.graph, ctx.store, entity, fields, row, flash, ctx.vc, await detailPre(ctx, entity, fields, row));

// A static page: the rows of each embedded saved list, and the options of each embedded create form.
export async function pagePre(ctx, p) {
  const { graph, store, vc, resolveTop } = ctx;
  const sections = new Map(), pairs = [], targets = [];
  for (const s of p.sections || []) {
    const l = sectionList(graph, vc, s);
    if (l) {
      const opts = { where: { ...await resolveTop(l.where || {}), ...await vc.ownWhere(l.entity) }, sort: l.sort, search: l.search || [] };
      // A limited preview hydrates only the rows it shows (item 2); unlimited stays store.list's full fetch.
      const rows = s.limit ? (await store.listPage(l.entity, opts, { page: 1, pageSize: s.limit })).rows : await store.list(l.entity, opts);
      await vc.prime(l.entity, rows);
      sections.set(s, rows);
      pairs.push(...refPairs(store.fields[l.entity], columnsOf(l, store.fields[l.entity]), rows));
    }
    const f = sectionForm(graph, store, vc, s);
    if (f) targets.push(...inputTargets(store, f.entity, f.fields, f.only, f.skip));
  }
  return prefetched(await store.labelsFor(pairs), await store.optionsFor(targets), { sections });
}

// The /search sections: rows primed for the viewer's ownership checks, the labels of their reference cells.
export async function searchPre({ graph, store, vc }, results) {
  const pairs = [];
  for (const { entity, rows } of results) {
    await vc.prime(entity, rows);
    pairs.push(...refPairs(store.fields[entity], columnsOf(graph.override?.[`${entity}.list`] || {}, store.fields[entity]), rows));
  }
  return prefetched(await store.labelsFor(pairs));
}

// /register: the options of the reference inputs on the sign-up form.
export async function registerPre({ graph, store }, fields) {
  return prefetched(await store.labelsFor([]), await store.optionsFor(inputTargets(store, graph.roles.entity, fields, null, [graph.roles.role])));
}

// A dashboard: every aggregate its cards, tables and charts show (the same `aggregate` calls the CSV and
// JSON answers make), narrowed to the period, and the labels of the reference groups. `mine` is the
// dashboard with each part already scoped to what the viewer may read (routes/views.mjs).
export async function dashboardPre({ store }, d, mine, period) {
  const inPeriod = (entity, where = {}) => {
    const f = d.period?.[entity];
    if (!f || (!period.from && !period.to)) return where;
    const kind = store.field(entity, f).kind;
    const range = {};
    if (period.from) range.gte = kind === 'time' ? `${period.from}T00:00:00` : period.from;
    if (period.to) range.lte = kind === 'time' ? `${period.to}T23:59:59.999Z` : period.to;
    return { ...where, [f]: range };
  };
  // One aggregate after the other, in declared order: the queries leave the store exactly as they always did.
  const cards = [], tables = [], charts = [];
  for (const c of mine.cards || []) cards.push((await store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: inPeriod(c.entity, c.where) }))[0]?.v);
  for (const t of mine.tables || []) tables.push(await store.aggregate(t.entity, { ...t, where: inPeriod(t.entity, t.where) }));
  for (const c of mine.charts || []) charts.push(await store.aggregate(c.entity, { groupBy: c.groupBy, groupUnit: c.groupUnit,
    metrics: [{ fn: c.metric.fn, field: c.metric.field, as: 'v' }], sort: c.sort, limit: c.limit, where: inPeriod(c.entity, c.where) }));
  const groups = [...(mine.tables || []).map((t, i) => [t, tables[i]]), ...(mine.charts || []).map((c, i) => [c, charts[i]])];
  const pairs = groups.flatMap(([x, rows]) => {
    const g = x.groupBy ? store.field(x.entity, x.groupBy) : null;
    return g?.kind === 'ref' ? rows.map((r) => [g.target, r.grp]) : [];
  });
  return prefetched(await store.labelsFor(pairs), new Map(), { dash: { cards, tables, charts } });
}
