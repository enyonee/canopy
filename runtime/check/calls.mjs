// `connector.call` (block check): the call is held against the descriptor the connector's kind
// names — the operation exists, the input has the operation's shape, a literal value fits its
// schema, a "@row.field" reference has a compatible type. Values only known at run time ("= expr",
// references to anything but the row's own field) are left to the enqueue-time check
// (runtime/connectors/engine.mjs `prepare`), which is the backstop. Not a node-kind checker.
import { near } from './util.mjs';
import { isExpression } from '../expr.mjs';
import { validate } from '../connectors/schema.mjs';

// The schema type a field's value has, by field kind (plugin kinds are unknown: not checked).
const KIND_TYPE = { text: 'string', longtext: 'string', date: 'string', time: 'string', enum: 'string', bool: 'boolean', int: 'integer', money: 'number', ref: 'integer' };
const isDynamic = (v) => (typeof v === 'string' ? v.startsWith('@') || isExpression(v)
  : Array.isArray(v) ? v.some(isDynamic) : v !== null && typeof v === 'object' && Object.values(v).some(isDynamic));
const compatible = (want, have) => want === have || (want === 'number' && have === 'integer');

function checkRowField(schema, value, path, h) {
  const m = /^@row\.(\w+)$/.exec(value);
  const f = m && h.entity && h.fields[h.entity]?.[m[1]];
  const have = f && KIND_TYPE[f.kind];
  if (have && schema.type && !compatible(schema.type, have)) h.err(path, `${value} is ${f.kind} (${have}) but this input is ${schema.type}`);
}

function checkInput(input, schema, path, h) {
  const props = schema.properties;
  for (const k of schema.required || []) if (input[k] === undefined) h.err(path, `the operation needs input "${k}"`, `inputs: ${Object.keys(props || {}).join(', ')}`);
  for (const [k, v] of Object.entries(input)) {
    const p = `${path}/${k}`;
    if (!props) continue;
    if (!props[k]) {
      if (!schema.additionalProperties) h.err(p, `unknown input "${k}"`, `inputs: ${Object.keys(props).join(', ')}`);
    } else if (typeof v === 'string' && v.startsWith('@')) checkRowField(props[k], v, p, h);
    else if (!isDynamic(v)) for (const [at, message] of validate(props[k], v, '')) h.err(`${p}${at}`, message);
  }
}

/** The check of a `connector.call` step: h is the block-check toolbox (err, graph, registry, path, entity, fields). */
export function checkCall(step, h) {
  const { err, graph, registry, path } = h;
  const c = graph.connectors?.[step.connector];
  if (!c) return err(`${path}/connector`, `unknown connector "${step.connector}"`, `declared: ${Object.keys(graph.connectors || {}).join(', ') || '(none; add /connectors)'}`);
  const d = registry.descriptors[c.kind];
  if (!d) return err(`${path}/connector`, `connector "${step.connector}" is ${c.kind}, which has no descriptor`, `kinds with a descriptor: ${Object.keys(registry.descriptors).join(', ')}`);
  const op = d.operations[step.op];
  if (!op) {
    const n = near(String(step.op), Object.keys(d.operations));
    return err(`${path}/op`, `${d.name} has no operation "${step.op}"`, n.length ? `did you mean: ${n.join(', ')}?` : `operations: ${Object.keys(d.operations).join(', ')}`);
  }
  if (step.input === null || typeof step.input !== 'object' || Array.isArray(step.input)) return err(`${path}/input`, 'input is an object with the inputs of the operation');
  checkInput(step.input, op.input, `${path}/input`, h);
  if (step.ref !== undefined && !(typeof step.ref === 'string' && /^@[a-z]+$/.test(step.ref))) err(`${path}/ref`, '"ref" names the row the call is about: "@row", "@found"…');
}
