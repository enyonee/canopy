// Field-spec parsing: the syntax of a field declaration. The kinds themselves
// live in the registry (fields.mjs and plugins); this file only knows the shape:
//   "text!"            required; "?" optional (the default)
//   "int=0"            with a default
//   "enum[a,b]=a"      a closed set (structural, kernel)
//   "ref:Entity?"      a reference (structural, kernel)
//   "money := expr"    derived: computed on read, never stored
import { parse as parseExpr } from './expr.mjs';
import { FIELDS } from './fields.mjs';
export { toMinor, toMajor, formatMoney } from './fields.mjs';

export function parseField(name, spec, fields = FIELDS, functions = undefined) {
  if (typeof spec !== 'string') throw new Error(`field ${name}: spec must be a string`);
  let rest = spec.trim();
  let source = null;
  const d = rest.indexOf(':=');
  if (d !== -1) { source = rest.slice(d + 2).trim(); rest = rest.slice(0, d).trim(); }
  let def = null;
  const eq = rest.indexOf('=');
  if (eq !== -1) { def = rest.slice(eq + 1); rest = rest.slice(0, eq); }
  let required = false, optional = false;
  if (rest.endsWith('!')) { required = true; rest = rest.slice(0, -1); }
  if (rest.endsWith('?')) { optional = true; rest = rest.slice(0, -1); }

  let kind = rest, options = null, target = null;
  const em = /^enum\[([^\]]*)\]$/.exec(rest);
  if (em) { kind = 'enum'; options = em[1].split(',').map((s) => s.trim()).filter(Boolean); }
  const rm = /^ref:(\w+)$/.exec(rest);
  if (rm) { kind = 'ref'; target = rm[1]; }

  const type = fields[kind];
  if (!type) {
    const names = Object.keys(fields).filter((k) => !['enum', 'ref'].includes(k));
    throw new Error(`field ${name}: unknown type "${rest}"; known: ${names.join(', ')}, enum[...], ref:Entity`);
  }
  if (kind === 'enum' && !options.length) throw new Error(`field ${name}: enum needs at least one option`);
  if (kind === 'enum' && def !== null && !options.includes(def)) throw new Error(`field ${name}: default "${def}" is not one of ${options.join(', ')}`);

  let derive = null;
  if (source !== null) {
    if (!source) throw new Error(`field ${name}: ":=" needs an expression`);
    if (!type.derivable) throw new Error(`field ${name}: a ${kind} field cannot be derived`);
    if (def !== null || required || optional) throw new Error(`field ${name}: a derived field takes no default and no ! or ? marker`);
    try { derive = parseExpr(source, functions); } catch (e) { throw new Error(`field ${name}: ${e.message}`); }
  }
  return { name, kind, options, target, required, optional, def, derive, source, type };
}

export const isStored = (f) => !f.derive;
export const sqlType = (f) => f.type.sql;
export const exprKind = (f) => f.type.exprKind;

export function defaultValue(f) {
  if (f.def === null || f.def === undefined) return f.kind === 'bool' ? 0 : null;
  return f.type.def(f);
}

// A submitted value in storage form.
export const coerce = (f, raw) => f.type.coerce(raw);
// A stored value as an expression sees it, and back.
export const toExpr = (f, v) => (f.type.toExpr ? f.type.toExpr(v) : v);
export const fromExpr = (f, v) => (f.type.fromExpr ? f.type.fromExpr(v) : v === undefined ? null : v);
