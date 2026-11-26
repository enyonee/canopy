export const maxMinor = 99999999999;
export const money = (n) => Number.isSafeInteger(n) && n > 0 && n <= maxMinor;
export const textId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);
export const description = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 200;
export const invalid = [400, { error: 'invalid request' }];
export const refused = [422, { error: 'provider rejected the operation' }];
export const drift = [502, { error: 'unexpected provider response' }];

export function asMinor(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

export function https(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}

export async function providerJson(fetchImpl, url, headers, body) {
  const response = await fetchImpl(url, { method: 'POST', headers, body,
    redirect: 'manual', signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error('provider HTTP failure');
  const result = await response.json();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('unexpected provider content');
  return result;
}
