// Field-spec parsing: the whole type vocabulary of the format lives here.
//   "text!"            required text
//   "longtext"         optional multiline text
//   "bool=false"       boolean with default
//   "int=0"            integer
//   "time=now"         ISO timestamp, "now" default
//   "enum[a,b]=a"      closed set
//   "ref:Entity?"      reference to another entity
const KINDS = new Set(['text', 'longtext', 'bool', 'int', 'time', 'enum', 'ref']);

export function parseField(name, spec) {
  if (typeof spec !== 'string') throw new Error(`field ${name}: spec must be a string`);
  let rest = spec.trim();
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
    throw new Error(`field ${name}: unknown type "${rest}"; known: text, longtext, bool, int, time, enum[...], ref:Entity`);
  }
  if (kind === 'enum' && !options.length) throw new Error(`field ${name}: enum needs at least one option`);
  return { name, kind, options, target, required, optional, def };
}

export const sqlType = (f) => (f.kind === 'int' || f.kind === 'bool' ? 'INTEGER' : 'TEXT');

export function defaultValue(f) {
  if (f.def === null || f.def === undefined) return f.kind === 'bool' ? 0 : null;
  if (f.kind === 'bool') return f.def === 'true' ? 1 : 0;
  if (f.kind === 'int') return Number(f.def);
  if (f.kind === 'time') return f.def === 'now' ? new Date().toISOString() : f.def;
  return f.def;
}

export function coerce(f, raw) {
  if (f.kind === 'bool') return raw === true || raw === 1 || raw === 'true' || raw === 'on' || raw === '1' ? 1 : 0;
  if (f.kind === 'int') return raw === '' || raw === undefined || raw === null ? null : Number(raw);
  if (raw === undefined) return null;
  return String(raw);
}
