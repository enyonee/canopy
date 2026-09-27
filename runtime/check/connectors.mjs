// `/connectors`: http and mail endpoints the app may send to. Each transport
// in the registry says what is wrong with its own declaration.
export const NODES = ['connectors'];

export function check(graph, h) {
  const { err, registry } = h;
  for (const [name, c] of Object.entries(graph.connectors || {})) {
    const p = `/connectors/${name}`;
    if (!c || typeof c !== 'object') { err(p, 'connector must be an object'); continue; }
    const transport = registry.transports[c.kind];
    if (!transport) { err(`${p}/kind`, `unknown connector kind "${c.kind}"`, `kinds: ${Object.keys(registry.transports).join(', ')}`); continue; }
    for (const [key, message, hint] of transport.validate(c)) err(`${p}/${key}`, message, hint);
  }
}
