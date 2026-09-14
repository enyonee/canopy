// Field-spec parsing: the whole type vocabulary of the format lives here.
//   "text!"            required text
//   "longtext"         optional multiline text
//   "bool=false"       boolean with default
//   "int=0"            integer
//   "money=0"          money: written and read as 12.34, stored as integer minor units
//   "date=today"       calendar date, YYYY-MM-DD
//   "time=now"         ISO timestamp, "now" default
//   "enum[a,b]=a"      closed set
//   "ref:Entity?"      reference to another entity
//   "file"             an uploaded file, kept by name in the app's files directory
//   "password!"        a secret: stored as a salted hash, never rendered
//   "money := sum(OrderItem: qty * price)"   derived: computed on read, never stored
import { parse as parseExpr } from './expr.mjs';

const KINDS = new Set(['text', 'longtext', 'bool', 'int', 'money', 'date', 'time', 'enum', 'ref', 'file', 'password']);
export const NUMERIC = new Set(['int', 'money']);
const NOT_DERIVABLE = new Set(['ref', 'file', 'password', 'enum']);

export function parseField(name, spec) {
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

  if (!KINDS.has(kind)) {
    throw new Error(`field ${name}: unknown type "${rest}"; known: text, longtext, bool, int, money, date, time, enum[...], ref:Entity, file, password`);
  }
  if (kind === 'enum' && !options.length) throw new Error(`field ${name}: enum needs at least one option`);
  if (kind === 'enum' && def !== null && !options.includes(def)) throw new Error(`field ${name}: default "${def}" is not one of ${options.join(', ')}`);

  let derive = null;
  if (source !== null) {
    if (!source) throw new Error(`field ${name}: ":=" needs an expression`);
    if (NOT_DERIVABLE.has(kind)) throw new Error(`field ${name}: a ${kind} field cannot be derived`);
    if (def !== null || required || optional) throw new Error(`field ${name}: a derived field takes no default and no ! or ? marker`);
    try { derive = parseExpr(source); } catch (e) { throw new Error(`field ${name}: ${e.message}`); }
  }
  return { name, kind, options, target, required, optional, def, derive, source };
}

export const isStored = (f) => !f.derive;
export const sqlType = (f) => (NUMERIC.has(f.kind) || f.kind === 'bool' ? 'INTEGER' : 'TEXT');

const today = () => new Date().toISOString().slice(0, 10);

export function defaultValue(f) {
  if (f.def === null || f.def === undefined) return f.kind === 'bool' ? 0 : null;
  if (f.kind === 'bool') return f.def === 'true' ? 1 : 0;
  if (f.kind === 'int') return Number(f.def);
  if (f.kind === 'money') return toMinor(f.def);
  if (f.kind === 'date') return f.def === 'today' ? today() : f.def;
  if (f.kind === 'time') return f.def === 'now' ? new Date().toISOString() : f.def;
  return f.def;
}

// Money crosses the boundary in major units and lives in storage in minor units.
export const toMinor = (v) => (v === '' || v === undefined || v === null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));
export const toMajor = (v) => (v === null || v === undefined ? null : v / 100);
export const formatMoney = (v) => (v === null || v === undefined ? '' : (v / 100).toFixed(2));

export function coerce(f, raw) {
  if (f.kind === 'bool') return raw === true || raw === 1 || raw === 'true' || raw === 'on' || raw === '1' ? 1 : 0;
  if (f.kind === 'int') return raw === '' || raw === undefined || raw === null ? null : Number(raw);
  if (f.kind === 'money') return toMinor(raw);
  if (raw === undefined) return null;
  return String(raw);
}

// The kind an expression sees when it reads this field.
export const exprKind = (f) => (f.kind === 'int' ? 'number' : f.kind === 'longtext' || f.kind === 'enum' || f.kind === 'file' || f.kind === 'password' ? 'text' : f.kind);
