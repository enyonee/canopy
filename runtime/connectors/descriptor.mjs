// A connector descriptor is data: what a service is called, what each operation takes,
// how the request is built and what the answer must look like. `checkDescriptor`
// says what is wrong with one — fail closed: a key it does not know is an error, so
// a descriptor written for a later stage cannot half-work today. It returns
// [[path, message, hint?]], empty when the descriptor is usable.
import { checkSchema } from './schema.mjs';
import { refs, pathSteps, originProblem } from './template.mjs';

// The longest an operation may wait: half the outbox lease (runtime/outbox.mjs LEASE_MS),
// so a slow provider cannot outlive the claim on its row and be delivered twice.
export const MAX_TIMEOUT_MS = 30000;
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TOP = ['descriptor', 'name', 'title', 'version', 'base', 'config', 'timeoutMs', 'legacy', 'operations'];
const OP = ['summary', 'idempotent', 'input', 'request', 'output', 'result'];
const REQUEST = ['method', 'url', 'headers', 'body'];
const NAME = /^[A-Za-z_][\w-]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const unknownKeys = (obj, allowed, path) => Object.keys(obj).filter((k) => !allowed.includes(k))
  .map((k) => [`${path}/${k}`, `unknown key "${k}"`, `allowed: ${allowed.join(', ')}`]);

// The references of one template structure, checked against what the scope may name.
function checkRefs(value, path, ctx) {
  let list;
  try { list = refs(value); } catch (e) { return [[path, e.message]]; }
  const out = [];
  for (const { scope, path: names } of list) {
    if (scope === 'key') out.push([path, '{key} (the idempotency key) arrives with retries; it is not available yet']);
    else if (scope === 'base' && ctx.base === undefined) out.push([path, '{base} needs a "base" at the top of the descriptor']);
    else if (scope === 'secret' && ctx.noSecret) out.push([path, '{secret.*} may not appear here: the value would be shown in the outbox and the trace', 'put the secret in a header']);
    else if (scope === 'input' && ctx.noInput) out.push([path, '{input.*} may not appear here: it is the same for every call'])
    else if (scope === 'input' && names.length && ctx.input && !(names[0] in ctx.input)) out.push([path, `{input.${names[0]}} is not an input of this operation`, `inputs: ${Object.keys(ctx.input).join(', ') || '(none)'}`]);
    else if (scope === 'config' && names.length && !(ctx.config && names[0] in ctx.config)) out.push([path, `{config.${names[0]}} is not declared in "config"`, `config: ${Object.keys(ctx.config || {}).join(', ') || '(none)'}`]);
  }
  return out;
}

function checkRequest(req, path, ctx) {
  if (!isObject(req)) return [[path, 'an operation needs a "request" object']];
  const out = unknownKeys(req, REQUEST, path);
  if (typeof req.url !== 'string') out.push([`${path}/url`, 'a request needs "url" as a template string']);
  else {
    const bad = checkRefs(req.url, `${path}/url`, { ...ctx, noSecret: true });
    out.push(...bad);
    const origin = bad.length ? null : originProblem(req.url);
    if (origin) out.push([`${path}/url`, origin, 'https://{config.host}/items/{input.id}']);
  }
  if (req.method !== undefined) {
    if (typeof req.method !== 'string') out.push([`${path}/method`, '"method" is a string']);
    else if (!req.method.includes('{') && !METHODS.includes(req.method)) out.push([`${path}/method`, `unsupported method "${req.method}"`, METHODS.join(', ')]);
    else out.push(...checkRefs(req.method, `${path}/method`, { ...ctx, noSecret: true }));
  }
  if (req.headers !== undefined) out.push(...(isObject(req.headers) ? checkRefs(req.headers, `${path}/headers`, ctx) : [[`${path}/headers`, '"headers" is an object']]));
  if (req.body !== undefined) out.push(...checkRefs(req.body, `${path}/body`, ctx));
  return out;
}

function checkResult(op, path) {
  if (op.result === undefined) return [];
  if (!isObject(op.result)) return [[path, '"result" maps a name to a $.path']];
  const out = op.output === undefined ? [[path, '"result" reads the answer, so the operation needs an "output" schema']] : [];
  for (const [k, p] of Object.entries(op.result)) {
    try { pathSteps(p); } catch (e) { out.push([`${path}/${k}`, e.message]); }
  }
  return out;
}

function checkInput(op, path) {
  if (op.input === undefined) return [[path, 'an operation needs an "input" schema', '{"type": "object", "properties": {}}']];
  const out = checkSchema(op.input, path);
  if (op.input.type !== 'object') out.push([`${path}/type`, 'an operation input is an object: "type" must be "object"']);
  for (const k of Object.keys(op.input.properties || {})) if (!NAME.test(k)) out.push([`${path}/properties/${k}`, `"${k}" cannot be named in a template`]);
  return out;
}

function checkOperation(op, path, top) {
  if (!isObject(op)) return [[path, 'an operation is an object']];
  const out = unknownKeys(op, OP, path);
  if (typeof op.idempotent !== 'boolean') out.push([`${path}/idempotent`, 'every operation says whether it is idempotent, true or false', 'there is no default: a retry after a timeout must be a decision']);
  out.push(...checkInput(op, `${path}/input`));
  out.push(...checkRequest(op.request, `${path}/request`, { input: op.input?.properties, config: top.config?.properties, base: top.base }));
  if (op.output !== undefined) out.push(...checkSchema(op.output, `${path}/output`));
  return out.concat(checkResult(op, `${path}/result`));
}

function checkTop(d) {
  const out = unknownKeys(d, TOP, '');
  if (d.descriptor !== 1) out.push(['/descriptor', 'the descriptor format version is 1', '"descriptor": 1']);
  if (typeof d.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(d.name)) out.push(['/name', 'a descriptor has a "name": lower case letters, digits and "-"', '"name": "stripe"']);
  for (const k of ['title', 'version']) if (d[k] !== undefined && typeof d[k] !== 'string') out.push([`/${k}`, `"${k}" is a string`]);
  if (d.timeoutMs !== undefined && !(Number.isInteger(d.timeoutMs) && d.timeoutMs >= 1 && d.timeoutMs <= MAX_TIMEOUT_MS))
    out.push(['/timeoutMs', `"timeoutMs" is a whole number of milliseconds, 1 to ${MAX_TIMEOUT_MS}`, 'half the delivery lease, so a slow call cannot outlive its claim']);
  if (d.base !== undefined) out.push(...(typeof d.base === 'string' ? checkRefs(d.base, '/base', { noSecret: true, noInput: true, config: d.config?.properties }) : [['/base', '"base" is a string template']]));
  if (d.config !== undefined) out.push(...checkSchema(d.config, '/config'), ...(d.config?.type === 'object' ? [] : [['/config/type', '"config" describes an object: "type" must be "object"']]));
  return out;
}

/** What is wrong with a descriptor: [[path, message, hint?]]. */
export function checkDescriptor(d) {
  if (!isObject(d)) return [['/', 'a descriptor is an object']];
  const out = checkTop(d);
  const ops = isObject(d.operations) ? Object.entries(d.operations) : [];
  if (!ops.length) out.push(['/operations', 'a descriptor has at least one operation', '"operations": {"send": {…}}']);
  for (const [name, op] of ops) {
    if (!NAME.test(name)) out.push([`/operations/${name}`, `"${name}" cannot be an operation name`]);
    out.push(...checkOperation(op, `/operations/${name}`, d));
  }
  if (d.legacy !== undefined && !ops.some(([n]) => n === d.legacy)) out.push(['/legacy', `"legacy" names an operation this descriptor does not have`]);
  return out;
}
