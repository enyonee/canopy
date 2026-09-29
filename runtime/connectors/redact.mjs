// Masking of secret values in text and in data that is about to be stored, traced or shown.
// Pure: the caller passes the values. A value is masked as it is, as JSON text and as a
// URL component, so an echo of it in a provider's answer or an error does not survive.
const MASK = '«secret»';

const forms = (v) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)];

/** `text` with every occurrence of every value replaced by MASK (longest first). */
export function redact(text, values) {
  const all = [...new Set(values.filter((v) => typeof v === 'string' && v !== '').flatMap(forms))].sort((a, b) => b.length - a.length);
  return all.reduce((t, v) => t.split(v).join(MASK), String(text));
}

/** The same for a value of any shape: every string in it, at any depth, is masked. */
export function redactDeep(value, values) {
  if (typeof value === 'string') return redact(value, values);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, values));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, values)]));
  return value;
}
