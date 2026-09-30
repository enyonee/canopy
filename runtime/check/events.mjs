// `/events`: steps that run on Entity.created / .updated / .deleted, on
// <roles.entity>.login (row = the user who just signed in), or on
// <Entity>.viewed (row = the row a GET detail just read — a write on read,
// still inside a transaction; see docs/FORMAT.md's «Events»), or — instead of `on` —
// `inbound: "<connector>.<type>"`: the webhook of a connector whose descriptor declares that event type
// (its steps get the payload's values as `@values.<name>`).
const TRIGGERS = ['created', 'updated', 'deleted', 'login', 'viewed'];

export const NODES = ['events'];

// `inbound: "pay.payment.succeeded"`: the connector is up to the first dot, the event type (which may have dots) the rest.
function checkInbound(ev, p, h) {
  const { err, graph, registry, checkSteps } = h;
  if (ev.on !== undefined) err(p, 'an event has "on" or "inbound", not both');
  const text = typeof ev.inbound === 'string' ? ev.inbound : '';
  const at = text.indexOf('.');
  const name = text.slice(0, at), type = text.slice(at + 1);
  const declared = Object.keys(graph.connectors || {});
  const c = at > 0 && declared.includes(name) ? graph.connectors[name] : null;
  const inbound = c ? registry.descriptors[c.kind]?.inbound : null;
  if (at < 1) err(`${p}/inbound`, `${JSON.stringify(ev.inbound)} is not "<connector>.<type>"`, 'e.g. "pay.payment.succeeded"');
  else if (!c) err(`${p}/inbound`, `unknown connector "${name}"`, `declared: ${declared.join(', ') || '(none; add /connectors)'}`);
  else if (!inbound) err(`${p}/inbound`, `connector "${name}" (${c.kind}) receives no webhooks: its descriptor has no "inbound"`);
  else if (!Object.hasOwn(inbound.events, type)) err(`${p}/inbound`, `"${c.kind}" sends no event "${type}"`, `event types: ${Object.keys(inbound.events).join(', ')}`);
  checkSteps(ev.do, `${p}/do`, null);
}

export function check(graph, h) {
  const { err, checkEntity, checkSteps, entities } = h;
  (graph.events || []).forEach((ev, i) => {
    const p = `/events/${i}`;
    if (ev.inbound !== undefined) { checkInbound(ev, p, h); return; }
    const m = /^(\w+)\.(\w+)$/.exec(ev.on || '');
    if (!m || !TRIGGERS.includes(m[2])) { err(`${p}/on`, `unsupported trigger "${ev.on}"`, `triggers: <Entity>.${TRIGGERS.join(', <Entity>.')}`); return; }
    const known = checkEntity(m[1], `${p}/on`);
    if (known && m[2] === 'login' && m[1] !== graph.roles?.entity)
      err(`${p}/on`, `"login" fires on the roles entity; ${m[1]} is not it`, graph.roles ? `use "${graph.roles.entity}.login"` : 'declare /roles first');
    checkSteps(ev.do, `${p}/do`, known ? m[1] : null);
  });
}
