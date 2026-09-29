// The sandbox of a descriptor: what an operation answers when nothing leaves the machine. Per
// operation an ordered list of rules `{ when?, status?, headers?, body? }`; the first rule whose
// `when` holds answers — `when` maps `input.a.b` to a value (equal) or to an object of comparisons
// `eq ne gt gte lt lte in present`. `body` is a template over `input`, `config` and `{key}` (the
// idempotency key: the same fake id on every retry). Pure: no network, no clock, no randomness.
import { refs, expand } from './template.mjs';

const OPS = {
  eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  ne: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  gt: (a, b) => typeof a === 'number' && a > b,
  gte: (a, b) => typeof a === 'number' && a >= b,
  lt: (a, b) => typeof a === 'number' && a < b,
  lte: (a, b) => typeof a === 'number' && a <= b,
  in: (a, b) => Array.isArray(b) && b.some((x) => OPS.eq(a, x)),
  present: (a, b) => (a !== undefined && a !== null) === b,
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RULE = ['when', 'status', 'headers', 'body'];

const valueAt = (key, input) => key.split('.').slice(1).reduce((v, k) => (isObject(v) ? v[k] : undefined), input);

function holds(when, input) {
  return Object.entries(when || {}).every(([key, want]) => {
    const got = valueAt(key, input);
    return isObject(want) ? Object.entries(want).every(([op, arg]) => op in OPS && OPS[op](got, arg)) : OPS.eq(got, want);
  });
}

/** The first matching rule's answer: { status, headers, body } (body already expanded), or null when none matches. */
export function sandboxAnswer(rules, { input, key, config }) {
  const rule = (rules || []).find((r) => holds(r.when, input));
  if (!rule) return null;
  return { status: rule.status ?? 200, headers: rule.headers || {}, body: expand(rule.body ?? {}, { input, config, key }) };
}

function checkWhen(when, path, inputs) {
  if (!isObject(when)) return [[path, '"when" maps input.<name> to a value or to comparisons']];
  const out = [];
  for (const [key, want] of Object.entries(when)) {
    if (!/^input\.[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(key)) out.push([`${path}/${key}`, '"when" keys read the input: input.<name>', 'input.amount']);
    else if (inputs && !(key.split('.')[1] in inputs)) out.push([`${path}/${key}`, `${key} is not an input of this operation`, `inputs: ${Object.keys(inputs).join(', ') || '(none)'}`]);
    if (isObject(want)) for (const op of Object.keys(want)) if (!(op in OPS)) out.push([`${path}/${key}/${op}`, `unknown comparison "${op}"`, `allowed: ${Object.keys(OPS).join(', ')}`]);
  }
  return out;
}

function checkBody(body, path, ctx) {
  let list;
  try { list = refs(body); } catch (e) { return [[path, e.message]]; }
  return list.flatMap(({ scope, path: names }) => {
    if (scope === 'input' && names.length && ctx.inputs && !(names[0] in ctx.inputs)) return [[path, `{input.${names[0]}} is not an input of this operation`]];
    return ['input', 'config', 'key'].includes(scope) ? [] : [[path, `{${scope}} cannot be used in a sandbox answer`, 'input, config and key only']];
  });
}

function checkRule(rule, path, ctx) {
  if (!isObject(rule)) return [[path, 'a sandbox rule is an object']];
  const out = Object.keys(rule).filter((k) => !RULE.includes(k)).map((k) => [`${path}/${k}`, `unknown key "${k}"`, `allowed: ${RULE.join(', ')}`]);
  if (rule.when !== undefined) out.push(...checkWhen(rule.when, `${path}/when`, ctx.inputs));
  if (rule.status !== undefined && !(Number.isInteger(rule.status) && rule.status >= 100 && rule.status <= 599)) out.push([`${path}/status`, '"status" is an HTTP status, 100 to 599']);
  if (rule.headers !== undefined && !(isObject(rule.headers) && Object.values(rule.headers).every((v) => typeof v === 'string'))) out.push([`${path}/headers`, '"headers" maps a name to a string']);
  if (rule.body !== undefined) out.push(...checkBody(rule.body, `${path}/body`, ctx));
  return out;
}

/** What is wrong with a descriptor's `sandbox` block, given the descriptor: [[path, message, hint?]]. */
export function checkSandbox(sb, d) {
  const has = Array.isArray(d.modes) && d.modes.includes('sandbox');
  if (sb === undefined) return has ? [['/sandbox', 'a descriptor with the "sandbox" mode needs a "sandbox" block', '"sandbox": {"operations": {"<op>": [{"status": 200, "body": {}}]}}']] : [];
  if (!has) return [['/sandbox', 'sandbox rules need "sandbox" in "modes"', '"modes": ["sandbox", "live"]']];
  if (!isObject(sb) || Object.keys(sb).some((k) => k !== 'operations') || !isObject(sb.operations)) return [['/sandbox', '"sandbox" is {"operations": {"<op>": [rules]}}']];
  const out = [];
  for (const [name, rules] of Object.entries(sb.operations)) {
    const op = d.operations?.[name], path = `/sandbox/operations/${name}`;
    if (!op) out.push([path, `"${name}" is not an operation of this descriptor`]);
    else if (!Array.isArray(rules) || !rules.length) out.push([path, 'an operation has a list of at least one rule']);
    else rules.forEach((r, i) => out.push(...checkRule(r, `${path}/${i}`, { inputs: op.input?.properties })));
  }
  for (const name of Object.keys(d.operations || {})) if (!(name in sb.operations)) out.push([`/sandbox/operations/${name}`, `a descriptor with the "sandbox" mode answers every operation: "${name}" has no rules`]);
  return out;
}

