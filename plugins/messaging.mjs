// Shared plugin: SMS and WhatsApp alerts. Like mail, the stand has no gateway:
// a message is recorded in the outbox, never actually sent. Both transports
// share one E.164-ish validation of the connector's "from"; the block accepts
// either kind through the same "connector" parameter (like connector.send,
// not the single-kind connector: 'http'/'mail' blocks), checking the kind
// itself instead.
const E164 = /^\+[1-9]\d{6,14}$/;

const smsLike = (kind) => ({
  summary: `a ${kind} message with "from" (E.164, e.g. "+15551234567"); recorded in the outbox`,
  validate: (c) => (E164.test(String(c.from || '')) ? [] : [['from', `an "${kind}" connector needs "from" as an E.164 number, e.g. "+15551234567"`]]),
  deliver: async () => ({ status: 'sent', code: null, error: null }),
});

export default {
  transports: { sms: smsLike('sms'), whatsapp: smsLike('whatsapp') },
  blocks: {
    'sms.send': {
      summary: 'queue a text message through the "sms" or "whatsapp" connector: "to" (E.164) and "text" (never empty; {row.field} placeholders)',
      effects: ['sms.out'], requires: ['connector', 'to', 'text'],
      check: (step, h) => {
        const c = h.graph.connectors?.[step.connector];
        if (c && !['sms', 'whatsapp'].includes(c.kind)) h.err(`${h.path}/connector`, `connector "${step.connector}" is ${c.kind}, sms.send needs an sms or whatsapp connector`);
      },
      run: async ({ store, graph, step, resolve, text }) => {
        const c = graph.connectors[step.connector];
        const to = String((await resolve({ v: step.to })).v ?? '');
        if (!E164.test(to)) throw new Error('sms.send: "to" must be an E.164 number, e.g. "+15551234567"');
        const body = await text(step.text);
        if (!body.trim()) throw new Error('sms.send: "text" cannot be empty');
        return { delivery: await store.enqueue({ kind: c.kind, connector: step.connector, target: to, payload: { from: c.from, to, text: body } }) };
      },
    },
  },
};
