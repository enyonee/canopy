// Reference app "checkout" — each check is one requirement: pay through Stripe (the descriptor's sandbox), the order
// is paid only by Stripe's signed webhook, the receipt goes through Postmark and a notice to staff through Slack
// (both sandbox), and the webhooks are signed exactly as the providers sign them. Nothing leaves the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { signHeaders } from '../../runtime/connectors/signature.mjs';

// The secrets the webhooks are signed with: verify/run.mjs puts them in the app's secret store before it boots.
export const secrets = { checkout_stripe_whsec: 'whsec_checkout_acceptance_only', checkout_slack_signing: 'slack_checkout_acceptance_only' };
const recipeOf = (name) => JSON.parse(fs.readFileSync(new URL(`../../connectors/${name}/descriptor.json`, import.meta.url), 'utf8')).inbound.signature;
const RECIPES = { pay: [recipeOf('stripe'), secrets.checkout_stripe_whsec], staff: [recipeOf('slack'), secrets.checkout_slack_signing] };

// A webhook as the provider sends it: no cookie, only the signature. `headers` replace or add after signing.
const hook = async (base, connector, payload, { secret = RECIPES[connector][1], at = Date.now(), headers = {}, sign = true } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload));
  const signed = sign ? signHeaders(RECIPES[connector][0], { raw, secret, now: at }) : {};
  const res = await fetch(`${base}/hook/${connector}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed, ...headers }, body: raw });
  return { status: res.status, body: await res.json() };
};
const intent = (id, type, order, extra = {}) => ({ id, object: 'event', type, data: { object: { id: `pi_checkout_${id}`, object: 'payment_intent', amount: 2500, currency: 'usd', metadata: order === undefined ? {} : { order: String(order) }, ...extra } } });
const plain = (html) => html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

let paid = null, second = null, third = null;

export const checks = [
  { task: 'A guest sees the products with their prices and cannot order',
    run: async ({ asGuest, get, rowWith, must }) => {
      asGuest();
      const { html, status } = await get('/Product');
      must(status === 200, `the product list returned ${status}`);
      must(rowWith(html, 'Blue mug')?.includes('12.50') && rowWith(html, 'Mountain poster')?.includes('25.00'), 'products or prices are missing');
      must(!html.includes('>Order<'), 'a guest sees the order button');
      return 'two products with money prices, no order button for a guest';
    } },
  { task: 'A customer registers and orders two mugs: the total is derived',
    run: async ({ post, get, follow, idOf, rowWith, must }) => {
      const r = await post('/register', { email: 'ann@checkout.test', password: 'secret1', name: 'Ann' });
      must(r.status === 303, `register returned ${r.status}`);
      const id = idOf((await get('/Product')).html, 'Blue mug');
      const list = await follow(`/Product/${id}/action/order`, { qty: 2 });
      const row = rowWith(list.html, 'Blue mug');
      must(row && row.includes('25.00') && row.includes('Placed'), `the order row is wrong: ${row}`);
      paid = idOf(list.html, 'Blue mug', 'Order');
      return `order #${paid}: 2 x Blue mug, total 25.00, placed`;
    } },
  { task: 'Paying creates a Stripe PaymentIntent in the sandbox: the order is "paying", not paid, and nothing leaves the machine',
    run: async ({ follow, get, login, rows, sink, must }) => {
      const r = await follow(`/Order/${paid}/go/pay`, {});
      must(/Payment started/.test(r.html) || /status">Paying/.test(r.html), `the order was not moved to paying: ${r.html.slice(0, 300)}`);
      must(/status">Paying/.test((await get(`/Order/${paid}`)).html), 'the order is not "paying"');
      await login('admin@checkout.test', 'admin123');
      const html = (await get('/outbox')).html;
      const row = rows(html).find((x) => x.includes('<td>stripe</td>'));
      must(row, 'no Stripe delivery in the outbox');
      const text = plain(row);
      must(/status">sent<\/span> 200/.test(text), `the Stripe call is not sent: ${text.slice(0, 300)}`);
      must(text.includes('https://api.stripe.com/v1/payment_intents'), 'the target is not the PaymentIntents url');
      must(/"amount": 2500/.test(text) && /"currency": "usd"/.test(text) && new RegExp(`"order": "?${paid}"?`).test(text), `the payload is wrong: ${text.slice(0, 400)}`);
      must(/pay[^<]*<\/td>[\s\S]*sandbox|sandbox/.test(plain(html)), 'the outbox does not show the sandbox mode');
      must(sink.received.length === 0, `something left the machine: ${JSON.stringify(sink.received.map((h) => h.path))}`);
      return 'PaymentIntent for 2500 usd carrying the order id, answered by the sandbox; order stays "paying"';
    } },
  { task: 'Stripe\'s signed payment_intent.succeeded marks the order paid, sends one receipt through Postmark and one notice to staff in Slack; the provider\'s retry changes nothing',
    run: async ({ base, get, rows, must }) => {
      const ev = intent('evt_paid_1', 'payment_intent.succeeded', paid);
      const r = await hook(base, 'pay', ev);
      must(r.status === 200 && r.body.ok === true && !r.body.duplicate, `the webhook was answered ${r.status} ${JSON.stringify(r.body)}`);
      must(/status">Paid/.test((await get(`/Order/${paid}`)).html), 'the order is not paid after the webhook');
      const count = async (kind, text) => rows(plain((await get('/outbox')).html)).filter((x) => x.includes(`<td>${kind}</td>`) && x.includes(text)).length;
      must(await count('postmark', `Receipt for order #${paid}`) === 1, 'expected one receipt letter');
      must(await count('slack', `Order #${paid} was paid`) === 1, 'expected one Slack notice');
      const mail = rows(plain((await get('/outbox')).html)).find((x) => x.includes('<td>postmark</td>'));
      must(mail.includes('ann@checkout.test') && /status">sent<\/span> 200/.test(mail), `the receipt is not sent to the customer: ${mail.slice(0, 300)}`);
      const slack = rows(plain((await get('/outbox')).html)).find((x) => x.includes('<td>slack</td>'));
      must(slack.includes('#orders') && /status">sent<\/span> 200/.test(slack), `the Slack notice is not sent: ${slack.slice(0, 300)}`);
      const again = await hook(base, 'pay', ev);
      must(again.body.duplicate === true, 'the provider\'s retry was not recognised');
      must(await count('postmark', `Receipt for order #${paid}`) === 1 && await count('slack', `Order #${paid} was paid`) === 1, 'the retry sent a second receipt or notice');
      return 'paid by the webhook; one letter, one Slack message; the retry is a duplicate';
    } },
  { task: 'A webhook that is unsigned, signed with another secret, signed too long ago or without an order changes nothing',
    run: async ({ base, login, get, follow, idOf, rowWith, must }) => {
      await login('ann@checkout.test', 'secret1');
      const id = idOf((await get('/Product')).html, 'Mountain poster');
      const list = await follow(`/Product/${id}/action/order`, {});
      second = idOf(list.html, 'Mountain poster', 'Order');
      await follow(`/Order/${second}/go/pay`, {});
      const ev = intent('evt_forged_1', 'payment_intent.succeeded', second);
      must((await hook(base, 'pay', ev, { sign: false })).status === 401, 'an unsigned webhook was accepted');
      must((await hook(base, 'pay', ev, { secret: 'whsec_somebody_else' })).status === 401, 'a webhook signed with another secret was accepted');
      must((await hook(base, 'pay', ev, { at: Date.now() - 10 * 60 * 1000 })).status === 401, 'a stale signature was accepted');
      const none = await hook(base, 'pay', intent('evt_noorder_1', 'payment_intent.succeeded', undefined));
      must(none.status === 200 && none.body.ok === true, `a payment of another app was answered ${none.status} ${JSON.stringify(none.body)}`);
      const html = (await get('/Order')).html;
      must(/status">Paying/.test(rowWith(html, 'Mountain poster') || ''), 'the order was paid by a webhook that should have changed nothing');
      return 'three refusals (401) and an event with no order: the paying order stays paying';
    } },
  { task: 'The operator can send the same event from the command line (--connectors simulate), signed with the stored secret, and it pays the order once',
    run: async ({ base, get, must }) => {
      const file = path.join(os.tmpdir(), `checkout-sim-${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify(intent('evt_sim_1', 'payment_intent.succeeded', second)));
      const sim = () => promisify(execFile)('node', ['--no-warnings', 'runtime/run.mjs', 'apps/checkout/app.json', '--connectors', 'simulate', 'pay', 'payment_intent.succeeded', '--data', file, '--port', new URL(base).port]);
      try {
        must((await sim()).stdout.trim() === '200 {"ok":true}', 'simulate was not accepted');
        must((await sim()).stdout.trim() === '200 {"ok":true,"duplicate":true}', 'simulate twice was not a duplicate');
      } finally { fs.rmSync(file, { force: true }); }
      must(/status">Paid/.test((await get(`/Order/${second}`)).html), 'the simulated event did not pay the order');
      return 'simulate pays the order, the second send is a duplicate';
    } },
  { task: 'A failed payment marks the order failed and tells staff; a refund marks a paid order refunded',
    run: async ({ base, login, get, follow, idOf, rows, must }) => {
      await login('ann@checkout.test', 'secret1');
      const id = idOf((await get('/Product')).html, 'Blue mug');
      third = idOf(await (await follow(`/Product/${id}/action/order`, {})).html, 'Blue mug', 'Order');
      await follow(`/Order/${third}/go/pay`, {});
      const failed = await hook(base, 'pay', intent('evt_failed_1', 'payment_intent.payment_failed', third, { last_payment_error: { code: 'card_declined' } }));
      must(failed.status === 200 && failed.body.ok === true, `the failure webhook was answered ${failed.status}`);
      must(/status">Failed/.test((await get(`/Order/${third}`)).html), 'the order is not failed');
      const refund = await hook(base, 'pay', { id: 'evt_refund_1', type: 'charge.refunded', data: { object: { id: 'ch_checkout_1', payment_intent: `pi_checkout_evt_paid_1`, amount_refunded: 2500, metadata: { order: String(paid) } } } });
      must(refund.status === 200 && refund.body.ok === true, `the refund webhook was answered ${refund.status}`);
      must(/status">Refunded/.test((await get(`/Order/${paid}`)).html), 'the paid order is not refunded');
      must(/status">Failed/.test((await get(`/Order/${third}`)).html), 'the refund touched another order');
      await login('admin@checkout.test', 'admin123');
      const slack = rows(plain((await get('/outbox')).html)).filter((x) => x.includes('<td>slack</td>') && x.includes(`Payment for order #${third} failed`));
      must(slack.length === 1, 'staff was not told about the failed payment');
      return 'failed -> Failed + a Slack notice; charge.refunded -> Refunded, only for the order it names';
    } },
  { task: 'Slack\'s url_verification challenge is answered when it is signed, and never otherwise',
    run: async ({ base, must }) => {
      const ask = { token: 'checkout-verification', challenge: 'challenge-checkout-0001', type: 'url_verification' };
      const ok = await hook(base, 'staff', ask);
      must(ok.status === 200 && ok.body.challenge === 'challenge-checkout-0001', `the challenge was answered ${ok.status} ${JSON.stringify(ok.body)}`);
      for (const [what, opts] of [['unsigned', { sign: false }], ['another secret', { secret: 'somebody_else' }], ['stale', { at: Date.now() - 10 * 60 * 1000 }]]) {
        const r = await hook(base, 'staff', ask, opts);
        must(r.status === 401 && !JSON.stringify(r.body).includes('challenge-checkout'), `${what}: answered ${r.status} ${JSON.stringify(r.body)}`);
      }
      return 'the signed challenge is echoed; unsigned, wrongly signed and stale ones are refused without an echo';
    } },
  { task: 'The admin opens /settings, sets a secret and sees it as "set" without its value ever appearing; a customer, a guest and a foreign site are refused',
    run: async ({ base, login, asGuest, get, post, must }) => {
      const value = 'Qx7Vz9Kp2Lm4Wn8R-acceptance';
      await login('admin@checkout.test', 'admin123');
      const before = await get('/settings');
      must(before.status === 200 && /<h3>pay /.test(before.html) && /<code>\/hook\/pay<\/code>/.test(before.html), `the settings screen is not shown: ${before.status}`);
      must(/checkout_postmark_token<\/code><\/td><td><span class="error">MISSING/.test(before.html), 'an unset secret is not MISSING');
      const set = await post('/settings/secret', { connector: 'mail', slot: 'serverToken', value }, { origin: base });
      must(set.status === 303 && !set.location.includes(value), `the save was answered ${set.status} ${set.location}`);
      const after = await get(set.location);
      must(/checkout_postmark_token<\/code><\/td><td><span class="status">set<\/span>/.test(after.html), 'the secret is not shown as set');
      const everything = [after.html, set.html, set.location, (await get('/outbox')).html, (await get('/settings')).html].join('\n');
      must(!everything.includes(value) && !everything.includes(value.slice(0, 8)), 'the value of the secret came back in a response');
      const foreign = await post('/settings/secret', { connector: 'mail', slot: 'serverToken', value: 'other-value-1234' }, { origin: 'https://evil.example' });
      must(foreign.status === 403, `a post from another site was answered ${foreign.status}`);
      const test = await post('/settings/test', { connector: 'staff' }, { origin: base });
      must(test.status === 200 && /status">sent<\/span> 200/.test(test.html), 'send test did not run through the sandbox');
      await login('ann@checkout.test', 'secret1');
      must((await get('/settings')).status === 403, 'a customer opened the settings');
      must((await post('/settings/secret', { connector: 'mail', slot: 'serverToken', value: 'other-value-1234' }, { origin: base })).status === 403, 'a customer set a secret');
      asGuest();
      must((await get('/settings')).status === 403, 'a guest opened the settings');
      await login('admin@checkout.test', 'admin123');
      return 'secret saved and shown as set, the value is in no response; a send test runs in the sandbox; customer, guest and a foreign origin get 403';
    } },
];
