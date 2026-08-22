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
  return pool.map((p) => [d(word.toLowerCase(), p.toLowerCase()), p]).sort((a, b) => a[0] - b[0])
    .filter(([n]) => n <= 3).slice(0, 3).map(([, p]) => p);
};

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
        if (f.kind === 'ref' && !entities.includes(f.target)) {
          err(`/data/${entity}/${name}`, `reference to unknown entity "${f.target}"`, `known entities: ${entities.join(', ')}`);
        }
        fields[entity][name] = f;
      } catch (e) { err(`/data/${entity}/${name}`, e.message); }
    }
  }

  if (graph.views !== undefined && graph.views !== 'auto') {
    err('/views', 'only "auto" is supported', 'screens are derived from /data; shape them in /override');
  }

  for (const [key, ov] of Object.entries(graph.override || {})) {
    const [entity, kind] = key.split('.');
    if (!entities.includes(entity)) {
      err(`/override/${key}`, `unknown entity "${entity}"`, `known entities: ${entities.join(', ')}`);
      continue;
    }
    if (!['list', 'form', 'detail'].includes(kind)) {
      err(`/override/${key}`, `unknown view "${kind}"`, 'views are: list, form, detail');
      continue;
    }
    const known = Object.keys(fields[entity]);
    const checkField = (f, where) => {
      if (!known.includes(f)) {
        const n = near(f, known);
        err(`/override/${key}/${where}`, `field "${f}" does not exist on ${entity}`,
          n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${entity}` : `known fields: ${known.join(', ')}`);
      }
    };
    (ov.columns || []).forEach((f) => checkField(f, 'columns'));
    (ov.search || []).forEach((f) => checkField(f, 'search'));
    (ov.filters || []).forEach((flt, i) => {
      if (!flt.field) err(`/override/${key}/filters/${i}`, 'filter needs a "field"');
      else checkField(flt.field, `filters/${i}/field`);
      if (!Array.isArray(flt.options) || !flt.options.length)
        err(`/override/${key}/filters/${i}`, 'filter needs non-empty "options"');
    });
    const actionNames = (graph.actions || []).map((a) => a.name);
    (ov.rowActions || []).forEach((a, i) => {
      if (['edit', 'delete'].includes(a)) return;
      if (!actionNames.includes(a))
        err(`/override/${key}/rowActions/${i}`, `unknown action "${a}"`,
          `built-in: edit, delete; declared in /actions: ${actionNames.join(', ') || '(none)'}`);
    });
  }

  (graph.actions || []).forEach((a, i) => {
    if (!a.name) err(`/actions/${i}/name`, 'action needs a name');
    if (!entities.includes(a.in))
      err(`/actions/${i}/in`, `unknown entity "${a.in}"`, `known entities: ${entities.join(', ')}`);
    if (!Array.isArray(a.do) || !a.do.length) err(`/actions/${i}/do`, 'action needs at least one step');
    (a.do || []).forEach((step, j) => {
      const block = CATALOG[step.block];
      if (!block) {
        const n = near(step.block || '', Object.keys(CATALOG));
        err(`/actions/${i}/do/${j}/block`, `unknown block "${step.block}"`,
          n.length ? `did you mean: ${n.join(', ')}?` : `catalog: ${Object.keys(CATALOG).join(', ')}`);
        return;
      }
      for (const p of block.requires || []) {
        if (step[p] === undefined) err(`/actions/${i}/do/${j}`, `block "${step.block}" requires "${p}"`, block.summary);
      }
      if (step.field && a.in && !fields[a.in]?.[step.field])
        err(`/actions/${i}/do/${j}/field`, `field "${step.field}" does not exist on ${a.in}`,
          `known fields: ${Object.keys(fields[a.in] || {}).join(', ')}`);
    });
  });

  return errors;
}

export const formatErrors = (errors) =>
  errors.map((e) => `  ✗ ${e.path}: ${e.message}${e.hint ? `\n      → ${e.hint}` : ''}`).join('\n');
