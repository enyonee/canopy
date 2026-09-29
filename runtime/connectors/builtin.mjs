// The descriptors that ship with the runtime, as JS literals: the default registry
// stays synchronous and never reads a file. A descriptor a graph names in "plugins"
// is the same shape, read from a .json file (runtime/registry.mjs).
//
// `http` is today's connector, unchanged: a JSON body to "url" (POST unless "method"
// says otherwise), "headers" merged over the content type, 3000 ms unless "timeout".
// An outbox row queued without an operation (http.send, connector.send) is delivered as
// "send" with its payload as the body and its target as the url ("legacy").
/** @type {Record<string, any>} */
export const BUILTIN = {
  http: {
    descriptor: 1,
    name: 'http',
    modes: ['live'],
    title: 'a JSON request to "url" (POST by default) with optional "headers" and "timeout"',
    timeoutMs: 3000,
    legacy: 'send',
    config: {
      type: 'object',
      additionalProperties: true,
      required: ['url'],
      properties: {
        url: { type: 'string', pattern: '^https?://', message: 'an http connector needs "url" starting with http:// or https://' },
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'GET'], default: 'POST', message: 'unsupported method "{value}"', hint: 'POST, PUT, PATCH or GET' },
        headers: { type: 'object' },
        timeout: { type: 'integer', minimum: 1 },
      },
    },
    operations: {
      send: {
        idempotent: false,
        input: { type: 'object', properties: { body: {} } },
        request: {
          method: '{config.method}',
          url: '{config.url}',
          headers: { 'content-type': 'application/json', '...': { $: 'config.headers' } },
          body: { $: 'input.body' },
        },
      },
    },
  },
};
