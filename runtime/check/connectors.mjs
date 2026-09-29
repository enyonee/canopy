// `/connectors`: the endpoints the app may send to. Each transport in the registry says what
// is wrong with its own declaration (a descriptor's configuration is checked against its
// "config" schema). Whatever the kind, app.json never holds a secret: it names one.
export const NODES = ['connectors'];

const SECRETY_KEY = /key|token|secret|password|authorization/i;
const SECRETY_VALUE = /^(?:(?:sk|pk|rk)_(?:live|test)?_?\w{8,}|Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;
const REFERENCE = /^\{secret\.[\w-]+\}$/;
const SECRET_IN_QUERY = /[?&][^=&]*(?:key|token|secret|password|auth)[^=&]*=[^&]+/i;
const HINT = 'put the secret in the secret store and name it here: {"secrets": {"apiKey": "stripe_key"}} or "{secret.apiKey}"';

function walk(value, path, key, err) {
  if (typeof value === 'string') {
    if (REFERENCE.test(value)) return;
    if ((SECRETY_KEY.test(key) && value !== '') || SECRETY_VALUE.test(value)) err(path, `a secret written into app.json ("${key}")`, HINT);
  } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}/${i}`, key, err));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'secrets') walk(v, `${path}/${k}`, k, err);
}

// The url becomes the row's "target", which /outbox and the trace show: no secret may be in it.
function checkUrl(url, path, err) {
  if (typeof url !== 'string') return;
  if (/\{secret\./.test(url)) err(path, 'a secret reference in a url would be shown in the outbox and the trace', 'send it in a header');
  else if (/\/\/[^/@]+:[^/@]*@/.test(url) || SECRET_IN_QUERY.test(url)) err(path, 'a credential in the url would be shown in the outbox and the trace', 'send it in a header');
}

export function check(graph, h) {
  const { err, registry } = h;
  for (const [name, c] of Object.entries(graph.connectors || {})) {
    const p = `/connectors/${name}`;
    if (!c || typeof c !== 'object') { err(p, 'connector must be an object'); continue; }
    const transport = registry.transports[c.kind];
    if (!transport) { err(`${p}/kind`, `unknown connector kind "${c.kind}"`, `kinds: ${Object.keys(registry.transports).join(', ')}`); continue; }
    for (const [key, message, hint] of transport.validate(c)) err(`${p}/${key}`, message, hint);
    walk(c, p, '', err);
    checkUrl(c.url, `${p}/url`, err);
  }
}
