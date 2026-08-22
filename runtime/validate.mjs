// The checker. Every error must name the path, the problem and the way out —
// the repair loop is where the tokens go, not the writing.
import { parseField } from './spec.mjs';
import { CATALOG } from './blocks.mjs';

const near = (word, pool) => {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return pool.map((p) => [d(String(word).toLowerCase(), p.toLowerCase()), p]).sort((a, b) => a[0] - b[0])
    .filter(([n]) => n <= 3).slice(0, 3).map(([, p]) => p);
};

const VIEWS = ['list', 'form', 'detail'];
const FNS = ['count', 'sum', 'avg', 'min', 'max'];

export function validate(graph) {
  const errors = [];
  const err = (path, message, hint) => errors.push({ path, message, hint });

  if (!graph || typeof graph !== 'object') return [{ path: '/', message: 'graph must be an object' }];
  if (!graph.app) err('/app', 'missing application name');
  if (!graph.data || typeof graph.data !== 'object' || !Object.keys(graph.data).length) {
    err('/data', 'at least one entity is required', 'e.g. {"Task": {"title": "text!"}}');
    return errors;
  }

  const entities = Object.keys(graph.data);
  const fields = {};
  for (const [entity, spec] of Object.entries(graph.data)) {
    fields[entity] = {};
    for (const [name, raw] of Object.entries(spec)) {
      try {
        const f = parseField(name, raw);
        if (f.kind === 'ref' && !entities.includes(f.target))
          err(`/data/${entity}/${name}`, `reference to unknown entity "${f.target}"`, `known entities: ${entities.join(', ')}`);
        fields[entity][name] = f;
      } catch (e) { err(`/data/${entity}/${name}`, e.message); }
    }
  }
  const known = (e) => Object.keys(fields[e] || {});
  const checkEntity = (e, path) => {
    if (entities.includes(e)) return true;
    err(path, `unknown entity "${e}"`, `known entities: ${entities.join(', ')}`);
    return false;
  };
  const checkField = (e, f, path) => {
    if (known(e).includes(f)) return true;
    const n = near(f, known(e));
    err(path, `field "${f}" does not exist on ${e}`,
      n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${e}` : `known fields: ${known(e).join(', ')}`);
    return false;
  };

  if (graph.views !== undefined && graph.views !== 'auto')
    err('/views', 'only "auto" is supported', 'screens are derived from /data; shape them in /override');

  if (graph.identity) {
    if (checkEntity(graph.identity.entity, '/identity/entity'))
      for (const k of Object.keys(graph.identity.defaults || {})) checkField(graph.identity.entity, k, `/identity/defaults/${k}`);
  }

  const actionNames = (graph.actions || []).map((a) => a.name);

  for (const [key, ov] of Object.entries(graph.override || {})) {
    const [entity, kind] = key.split('.');
    if (!checkEntity(entity, `/override/${key}`)) continue;
    if (!VIEWS.includes(kind)) { err(`/override/${key}`, `unknown view "${kind}"`, `views are: ${VIEWS.join(', ')}`); continue; }
    (ov.columns || []).forEach((f) => checkField(entity, f, `/override/${key}/columns`));
    (ov.search || []).forEach((f) => checkField(entity, f, `/override/${key}/search`));
    (ov.fields || []).forEach((f) => checkField(entity, f, `/override/${key}/fields`));
    if (ov.sort) checkField(entity, ov.sort.field, `/override/${key}/sort/field`);
    Object.keys(ov.fill || {}).forEach((f) => checkField(entity, f, `/override/${key}/fill/${f}`));
    Object.keys(ov.labels || {}).forEach((f) => checkField(entity, f, `/override/${key}/labels/${f}`));
    (ov.filters || []).forEach((flt, i) => {
      if (!flt.field) err(`/override/${key}/filters/${i}`, 'filter needs a "field"');
      else checkField(entity, flt.field, `/override/${key}/filters/${i}/field`);
      const f = fields[entity]?.[flt.field];
      if (!flt.options && f && !['ref', 'enum'].includes(f.kind))
        err(`/override/${key}/filters/${i}`, `filter on "${flt.field}" needs "options"`,
          'options are derived automatically only for ref and enum fields');
    });
    (ov.rowActions || []).forEach((a, i) => {
      if (['edit', 'delete', 'view'].includes(a)) return;
      if (!actionNames.includes(a))
        err(`/override/${key}/rowActions/${i}`, `unknown action "${a}"`,
          `built-in: view, edit, delete; declared in /actions: ${actionNames.join(', ') || '(none)'}`);
    });
    (ov.related || []).forEach((rel, i) => {
      const p = `/override/${key}/related/${i}`;
      if (!checkEntity(rel.entity, `${p}/entity`)) return;
      if (!rel.via) return err(`${p}/via`, 'related section needs "via" (the ref field on the child)');
      if (checkField(rel.entity, rel.via, `${p}/via`)) {
        const f = fields[rel.entity][rel.via];
        if (f.kind !== 'ref') err(`${p}/via`, `"${rel.via}" is ${f.kind}, not a reference`, `declare it as "ref:${entity}"`);
        else if (f.target !== entity) err(`${p}/via`, `"${rel.via}" points at ${f.target}, not ${entity}`);
      }
      (rel.columns || []).forEach((c) => checkField(rel.entity, c, `${p}/columns`));
      Object.keys(rel.fill || {}).forEach((c) => checkField(rel.entity, c, `${p}/fill/${c}`));
    });
  }

  (graph.lists || []).forEach((l, i) => {
    const p = `/lists/${i}`;
    if (!l.id) err(`${p}/id`, 'list needs an id (it becomes /list/<id>)');
    if (!checkEntity(l.entity, `${p}/entity`)) return;
    (l.columns || []).forEach((c) => checkField(l.entity, c, `${p}/columns`));
    Object.keys(l.where || {}).forEach((c) => checkField(l.entity, c, `${p}/where/${c}`));
    if (l.sort) checkField(l.entity, l.sort.field, `${p}/sort/field`);
  });

  (graph.dashboards || []).forEach((d, i) => {
    const p = `/dashboards/${i}`;
    if (!d.id) err(`${p}/id`, 'dashboard needs an id (it becomes /dashboard/<id>)');
    (d.cards || []).forEach((c, j) => {
      const cp = `${p}/cards/${j}`;
      if (!checkEntity(c.entity, `${cp}/entity`)) return;
      if (c.fn && !FNS.includes(c.fn)) err(`${cp}/fn`, `unknown function "${c.fn}"`, `known: ${FNS.join(', ')}`);
      if (c.fn && c.fn !== 'count' && !c.field) err(`${cp}/field`, `"${c.fn}" needs a field`);
      if (c.field) checkField(c.entity, c.field, `${cp}/field`);
      Object.keys(c.where || {}).forEach((f) => checkField(c.entity, f, `${cp}/where/${f}`));
    });
    (d.tables || []).forEach((t, j) => {
      const tp = `${p}/tables/${j}`;
      if (!checkEntity(t.entity, `${tp}/entity`)) return;
      if (t.groupBy) checkField(t.entity, t.groupBy, `${tp}/groupBy`);
      (t.metrics || []).forEach((m, k) => {
        if (!m.as) err(`${tp}/metrics/${k}/as`, 'metric needs a name in "as"');
        if (!FNS.includes(m.fn)) err(`${tp}/metrics/${k}/fn`, `unknown function "${m.fn}"`, `known: ${FNS.join(', ')}`);
        if (m.fn !== 'count') checkField(t.entity, m.field, `${tp}/metrics/${k}/field`);
      });
      if (t.sort && !(t.metrics || []).some((m) => m.as === t.sort.field) && t.sort.field !== 'grp')
        err(`${tp}/sort/field`, `sort must name a metric or "grp"`,
          `metrics here: ${(t.metrics || []).map((m) => m.as).join(', ')}`);
    });
  });

  (graph.pages || []).forEach((p, i) => {
    if (!p.id) err(`/pages/${i}/id`, 'page needs an id (it becomes /page/<id>)');
    if (!p.title) err(`/pages/${i}/title`, 'page needs a title (it is the menu label)');
    (p.actions || []).forEach((a, j) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/pages/${i}/actions/${j}`, `unknown action "${a}"`, `declared: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in) err(`/pages/${i}/actions/${j}`, `action "${a}" is bound to ${act.in}`, 'page buttons need a global action (no "in")');
    });
  });

  for (const [entity, rows] of Object.entries(graph.seed || {})) {
    if (!checkEntity(entity, `/seed/${entity}`)) continue;
    (rows || []).forEach((row, i) =>
      Object.keys(row).forEach((f) => checkField(entity, f, `/seed/${entity}/${i}/${f}`)));
  }

  const checkSteps = (steps, path, entity) => {
    (steps || []).forEach((step, j) => {
      const block = CATALOG[step.block];
      if (!block) {
        const n = near(step.block || '', Object.keys(CATALOG));
        return err(`${path}/${j}/block`, `unknown block "${step.block}"`,
          n.length ? `did you mean: ${n.join(', ')}?` : `catalog: ${Object.keys(CATALOG).join(', ')}`);
      }
      for (const req of block.requires || [])
        if (step[req] === undefined) err(`${path}/${j}`, `block "${step.block}" requires "${req}"`, block.summary);
      if (step.entity) checkEntity(step.entity, `${path}/${j}/entity`);
      if (step.from) checkEntity(step.from, `${path}/${j}/from`);
      if (step.field && entity) checkField(entity, step.field, `${path}/${j}/field`);
      if (step.via && step.entity) checkField(step.entity, step.via, `${path}/${j}/via`);
      if (step.set && entity) Object.keys(step.set).forEach((f) => checkField(entity, f, `${path}/${j}/set/${f}`));
      if (step.values && step.entity) Object.keys(step.values).forEach((f) => checkField(step.entity, f, `${path}/${j}/values/${f}`));
      if (step.into && entity) checkField(entity, step.into, `${path}/${j}/into`);
    });
  };

  (graph.actions || []).forEach((a, i) => {
    if (!a.name) err(`/actions/${i}/name`, 'action needs a name');
    if (a.in !== undefined && a.in !== null) checkEntity(a.in, `/actions/${i}/in`);
    if (!Array.isArray(a.do) || !a.do.length) err(`/actions/${i}/do`, 'action needs at least one step');
    checkSteps(a.do, `/actions/${i}/do`, a.in);
  });

  (graph.events || []).forEach((ev, i) => {
    const p = `/events/${i}`;
    const m = /^(\w+)\.created$/.exec(ev.on || '');
    if (!m) err(`${p}/on`, `unsupported trigger "${ev.on}"`, 'only "<Entity>.created" is supported');
    else checkEntity(m[1], `${p}/on`);
    checkSteps(ev.do, `${p}/do`, m ? m[1] : null);
  });

  return errors;
}

export const formatErrors = (errors) =>
  errors.map((e) => `  ✗ ${e.path}: ${e.message}${e.hint ? `\n      → ${e.hint}` : ''}`).join('\n');
