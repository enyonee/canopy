// Entities and their fields: parses every field spec, rejects a reference to
// an unknown entity, and — the expensive part — type-checks every derived
// (":=") expression against its entity and refuses a dependency cycle between
// derived fields (through hops and aggregates alike).
import { parseField, exprKind } from '../spec.mjs';

export const NODES = ['data'];

// Populates h.entities/h.fields; call before createScope() so the scope
// helpers close over the finished objects.
export function parseFields(graph, h) {
  const { err, registry } = h;
  for (const [entity, spec] of Object.entries(graph.data)) {
    h.fields[entity] = {};
    for (const [name, raw] of Object.entries(spec)) {
      try {
        const f = parseField(name, raw, registry.fields, registry.functions);
        if (f.kind === 'ref' && !h.entities.includes(f.target))
          err(`/data/${entity}/${name}`, `reference to unknown entity "${f.target}"`, `known entities: ${h.entities.join(', ')}`);
        h.fields[entity][name] = f;
      } catch (e) { err(`/data/${entity}/${name}`, e.message); }
    }
  }
}

// Derived fields depend on other fields — directly, through a hop, or inside
// an aggregate body. Walk each derivation's AST once to collect the derived
// fields it reaches, then look for a cycle in that dependency graph.
function derivedDeps(fields, entities) {
  const deps = {};
  for (const [entity, fs] of Object.entries(fields)) {
    for (const f of Object.values(fs)) {
      if (!f.derive) continue;
      const out = new Set();
      const walk = (ast, e, outer = null) => {
        const visit = (n) => {
          if (n.t === 'path') {
            let cur = e, segs = n.p;
            if (outer && segs[0] === 'row' && segs.length > 1) { cur = outer; segs = segs.slice(1); }
            for (const seg of segs) {
              const g = fields[cur]?.[seg];
              if (!g) break;
              if (g.derive) out.add(`${cur}.${seg}`);
              if (g.kind === 'ref') cur = g.target; else break;
            }
          } else if (n.t === 'agg') { if (entities.includes(n.entity) && n.body) walk(n.body, n.entity, e); }
          else if (n.t === 'un') visit(n.a);
          else if (n.t === 'bin') { visit(n.a); visit(n.b); }
          else if (n.t === 'call') n.args.forEach(visit);
        };
        visit(ast);
      };
      walk(f.derive, entity);
      deps[`${entity}.${f.name}`] = [...out];
    }
  }
  return deps;
}

function findCycle(deps) {
  const seen = {};
  const cycle = (key, stack) => {
    if (stack.includes(key)) return [...stack.slice(stack.indexOf(key)), key];
    if (seen[key]) return null;
    seen[key] = true;
    for (const d of deps[key] || []) { const c = cycle(d, [...stack, key]); if (c) return c; }
    return null;
  };
  for (const key of Object.keys(deps)) {
    const c = cycle(key, []);
    if (c) return { key, c };
  }
  return null;
}

// Requires h.entities/h.fields already populated (parseFields) and the scope
// helpers already mixed into h (createScope), for fieldScope-based type checks.
export function check(graph, h) {
  const { err, fields, fieldScope, checkExpression } = h;
  for (const [entity, fs] of Object.entries(fields)) {
    for (const f of Object.values(fs)) {
      if (!f.derive) continue;
      const path = `/data/${entity}/${f.name}`;
      const kind = checkExpression(f.source, fieldScope(entity), path);
      if (kind && kind !== 'any' && exprKind(f) !== kind && !(f.kind === 'text' && kind === 'text'))
        err(path, `derived ${f.kind} field gets a ${kind} expression`, `declare it as "${kind === 'number' ? 'int' : kind} := …" or change the expression`);
    }
  }
  const found = findCycle(derivedDeps(fields, h.entities));
  if (found) err(`/data/${found.key.replace('.', '/')}`, `derived fields depend on each other: ${found.c.join(' → ')}`, 'one of them has to be stored');
}
