// Shared expression-checking helpers: entity/field lookups (with near-miss
// hints), where-clauses, and the two expression scopes (a bare field path
// against an entity; a step's row/each/found/picked/me/values names). Built
// once per validate() call over the `h.fields`/`h.entities` the data checker
// fills in — a closure over the live object, not a snapshot, so it sees the
// finished picture regardless of call order. Split into one factory per
// concern only to stay under the function-size budget; createScope composes
// them into the single object every other checker reads through `h`.
import { parse as parseExpr, check as checkExpr, isExpression, stripExpression } from '../expr.mjs';
import { exprKind } from '../spec.mjs';
import { near } from './util.mjs';

const CMP = ['gte', 'lte', 'gt', 'lt', 'ne', 'in', 'like'];
const CTX_NAMES = ['me', 'now', 'today', 'created', 'delivery', 'values'];

function createEntityFieldChecks(h) {
  const { fields, entities, err } = h;
  const known = (e) => Object.keys(fields[e] || {});

  const checkEntity = (e, path) => {
    if (entities.includes(e)) return true;
    const n = near(e || '', entities);
    err(path, `unknown entity "${e}"`, n.length ? `did you mean: ${n.join(', ')}?` : `known entities: ${entities.join(', ')}`);
    return false;
  };

  const checkField = (e, f, path, { stored = false, secret = false } = {}) => {
    if (!known(e).includes(f)) {
      const n = near(f, known(e));
      err(path, `field "${f}" does not exist on ${e}`,
        n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${e}` : `known fields: ${known(e).join(', ')}`);
      return false;
    }
    if (stored && fields[e][f].derive) { err(path, `"${f}" is derived (:=) and cannot be written`, 'derived fields are computed on read'); return false; }
    if (secret && fields[e][f].type.secret) { err(path, `"${f}" is a ${fields[e][f].kind} and is never shown`, 'drop it from the columns'); return false; }
    return true;
  };

  // A where clause: { field: value } or { field: { gte, lte, gt, lt, ne, in, like } }.
  const checkWhere = (entity, where, path) => {
    for (const [f, cmp] of Object.entries(where || {})) {
      if (f !== 'id' && !checkField(entity, f, `${path}/${f}`)) continue;
      if (cmp && typeof cmp === 'object' && !Array.isArray(cmp))
        for (const [op, v] of Object.entries(cmp)) {
          if (!CMP.includes(op)) { err(`${path}/${f}/${op}`, `unknown comparison "${op}"`, `comparisons: ${CMP.join(', ')}`); continue; }
          // item 16: "null" is only meaningful on "ne" (IS NOT NULL); a bare field set to
          // null is already IS NULL, and every other comparison against null is never true.
          if (v === null && op !== 'ne') err(`${path}/${f}/${op}`, `"${op}: null" is never true`, '{"ne": null} means IS NOT NULL; the field itself set to null means IS NULL');
        }
    }
  };

  return { known, checkEntity, checkField, checkWhere };
}

// A bare field path against one entity, one hop through references, and the
// child scope an aggregate walks (fields.mjs's ref target, or the entity
// named in the aggregate for a reverse edge).
function createFieldScope(h, known) {
  const { fields, entities } = h;
  const childVia = (child, parent, via) => {
    const refs = Object.values(fields[child] || {}).filter((f) => f.kind === 'ref' && f.target === parent);
    if (via) {
      const f = fields[child]?.[via];
      if (!f || f.kind !== 'ref' || f.target !== parent) throw new Error(`${child}.${via} is not a reference to ${parent}`);
      return via;
    }
    if (refs.length === 1) return refs[0].name;
    if (!refs.length) return null; // no reference: the aggregate walks every row of the entity, the body correlates with row.
    throw new Error(`${child} references ${parent} through ${refs.map((f) => f.name).join(' and ')}; name one: ${child}.${refs[0].name}`);
  };
  const fieldScope = (entity) => ({
    field(path) {
      const [head, ...rest] = path;
      // "id" is read-only and always there, on every entity; it is never in
      // /data, so it needs a special case ahead of the real-field lookup.
      if (head === 'id') {
        if (rest.length) throw new Error(`${entity}.id is a number, cannot read .${rest[0]} of it`);
        return 'number';
      }
      const f = fields[entity]?.[head];
      if (!f) {
        const n = near(head, known(entity));
        throw new Error(`${entity} has no field "${head}"${n.length ? `; did you mean: ${n.join(', ')}?` : ''}`);
      }
      if (!rest.length) return exprKind(f);
      if (f.kind !== 'ref') throw new Error(`${entity}.${head} is ${f.kind}, cannot read .${rest[0]} of it`);
      return fieldScope(f.target).field(rest);
    },
    children(child, via) {
      if (!entities.includes(child)) throw new Error(`unknown entity "${child}" in aggregate`);
      childVia(child, entity, via);
      return fieldScope(child);
    },
  });
  return fieldScope;
}

// Inside steps, names are the row and the values around it: row.x, each.x, found.x, values.x, me…
function createStepScope(graph, fieldScope) {
  const userEntity = graph.roles?.entity || graph.identity?.entity || null;
  const stepScope = (ctxEntities) => ({
    field(path) {
      const [head, ...rest] = path;
      if (head === 'me' && rest.length) {
        if (!userEntity) throw new Error('"me" has no fields here: declare /roles or /identity');
        return fieldScope(userEntity).field(rest);
      }
      if (['me', 'created', 'delivery'].includes(head)) return 'ref';
      if (head === 'values') return 'any';
      if (ctxEntities[head]) return rest.length ? fieldScope(ctxEntities[head]).field(rest) : 'ref';
      if (ctxEntities.row) return fieldScope(ctxEntities.row).field(path);
      throw new Error(`unknown name "${head}"; available here: ${[...Object.keys(ctxEntities), ...CTX_NAMES].join(', ')}`);
    },
    children(child, via) {
      if (!ctxEntities.row) throw new Error(`no current row here to aggregate ${child} against`);
      return fieldScope(ctxEntities.row).children(child, via);
    },
  });
  return { stepScope, userEntity };
}

// Expression/reference checking over a step's values: "@path" and "= expr" both.
function createValueCheckers(h, fieldScope, stepScope, userEntity) {
  const { err, registry } = h;
  const checkExpression = (src, scope, path) => {
    try { return checkExpr(parseExpr(src, registry.functions), scope, registry.functions); }
    catch (e) { err(path, `bad expression: ${e.message}`, `expression: ${src}`); return null; }
  };
  const checkRefPath = (v, ctxEntities, path) => {
    const [head, ...rest] = v.slice(1).split('.');
    if (head === 'me' && rest.length) {
      if (!userEntity) return err(path, `"${v}" needs a user entity`, 'declare /roles or /identity, or use "@me"');
      try { fieldScope(userEntity).field(rest); } catch (e) { err(path, `bad reference "${v}": ${e.message}`); }
      return;
    }
    if (['me', 'now', 'today', 'created', 'delivery'].includes(head)) return;
    if (head === 'values') return;
    if (!ctxEntities[head]) {
      return err(path, `unknown reference "${v}"`, `available here: ${[...Object.keys(ctxEntities).map((k) => `@${k}.<field>`), '@me', '@created', '@now', '@today', '@values.<name>'].join(', ')}`);
    }
    if (rest.length && rest[0] !== 'id') {
      try { fieldScope(ctxEntities[head]).field(rest); } catch (e) { err(path, `bad reference "${v}": ${e.message}`); }
    }
  };
  const checkValues = (obj, ctxEntities, path) => {
    if (typeof obj === 'string') {
      if (obj.startsWith('@')) checkRefPath(obj, ctxEntities, path);
      else if (isExpression(obj)) checkExpression(stripExpression(obj), stepScope(ctxEntities), path);
      return;
    }
    if (Array.isArray(obj)) return obj.forEach((v, i) => checkValues(v, ctxEntities, `${path}/${i}`));
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) checkValues(v, ctxEntities, `${path}/${k}`);
  };
  return { checkExpression, checkRefPath, checkValues };
}

export function createScope(graph, h) {
  const entityField = createEntityFieldChecks(h);
  const fieldScope = createFieldScope(h, entityField.known);
  const { stepScope, userEntity } = createStepScope(graph, fieldScope);
  const values = createValueCheckers(h, fieldScope, stepScope, userEntity);
  return { ...entityField, fieldScope, stepScope, userEntity, ...values };
}
