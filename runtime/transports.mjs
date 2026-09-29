// Connector transports. One entry per connector kind: validate(connector) says
// what is wrong with its declaration; deliver(row, connector, opts) carries one
// outbox row and returns the status patch. A plugin adds a transport with the
// same shape (SMTP, a queue, a chat API…). A connector descriptor becomes one too
// (runtime/connectors/engine.mjs `synthesize`).
import { BUILTIN } from './connectors/builtin.mjs';
import { synthesize } from './connectors/engine.mjs';

/** @type {Record<string, import('./types.d.ts').TransportType>} */
export const TRANSPORTS = {
  // http is a built-in descriptor (runtime/connectors/builtin.mjs); the engine is its transport.
  http: synthesize(BUILTIN.http),
  mail: {
    // The stand transport: the letter is recorded, not carried. SMTP is a plugin's business.
    summary: 'a letter with "from"; recorded in the outbox',
    validate: () => [],
    deliver: async () => ({ status: 'sent', code: null, error: null }),
  },
};
