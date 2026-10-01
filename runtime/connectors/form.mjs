// `application/x-www-form-urlencoded` bodies the way providers with a bracket syntax read them:
// an object nests as `a[b]=1`, a list as `a[0]=x`, so `{metadata: {order: "7"}}` is `metadata[order]=7`.
// A null or absent value is left out (the provider's default applies), booleans are `true`/`false`.
// Brackets stay literal, every name and value is percent-encoded. Pure.
export const FORM_TYPE = 'application/x-www-form-urlencoded';

const enc = (s) => encodeURIComponent(s);
// A name keeps its brackets, so a flat key written as `metadata[order]` and a nested `metadata: {order}` encode alike.
const name = (k) => enc(k).replace(/%5B/gi, '[').replace(/%5D/gi, ']');

function walk(value, at, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`, out));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, at === '' ? name(k) : `${at}[${name(k)}]`, out);
  else out.push(`${at}=${enc(String(value))}`);
}

/** The form body of an object: `a=1&b[c]=2&d[0]=x`. Throws when the body is not an object (a form has names). */
export function formEncode(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('a form body is an object of names and values');
  const out = [];
  walk(body, '', out);
  return out.join('&');
}
