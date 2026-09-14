// Connector transports. One entry per connector kind: validate(connector) says
// what is wrong with its declaration; deliver(row, connector, opts) carries one
// outbox row and returns the status patch. A plugin adds a transport with the
// same shape (SMTP, a queue, a chat API…).
const TIMEOUT_MS = 3000;

export const TRANSPORTS = {
  http: {
    summary: 'a JSON request to "url" (POST by default) with optional "headers" and "timeout"',
    validate: (c) => {
      const out = [];
      if (!/^https?:\/\//.test(String(c.url || ''))) out.push(['url', 'an http connector needs "url" starting with http:// or https://']);
      if (c.method !== undefined && !['POST', 'PUT', 'PATCH', 'GET'].includes(c.method)) out.push(['method', `unsupported method "${c.method}"`, 'POST, PUT, PATCH or GET']);
      return out;
    },
    deliver: async (row, connector, { fetchImpl = fetch } = {}) => {
      const res = await fetchImpl(row.target, {
        method: connector.method || 'POST',
        headers: { 'content-type': 'application/json', ...(connector.headers || {}) },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(connector.timeout || TIMEOUT_MS),
      });
      return { code: res.status, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : `HTTP ${res.status}` };
    },
  },
  mail: {
    // The stand transport: the letter is recorded, not carried. SMTP is a plugin's business.
    summary: 'a letter with "from"; recorded in the outbox',
    validate: () => [],
    deliver: async () => ({ status: 'sent', code: null, error: null }),
  },
};
