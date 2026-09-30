// Reference app "shop" — each check is one requirement of a small web shop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { colorCheck, navCheck } from '../../verify/lib.mjs';
import { signHeaders } from '../../runtime/connectors/signature.mjs';

// The payment provider signs its webhooks with a secret the shop keeps in its secret store: verify/run.mjs puts
// these there before the app boots. A check signs exactly as the provider would (the recipe is the descriptor's own).
export const secrets = { psp_webhook: 'whsec_shop_acceptance_only' };
const recipe = JSON.parse(fs.readFileSync(new URL('./plugins/psp.json', import.meta.url), 'utf8')).inbound.signature;
// A webhook as the provider sends it: no cookie, no session, only the signature. `headers` replace or add after signing.
const hook = async (base, payload, { secret = secrets.psp_webhook, at = Date.now(), headers = {}, sign = true } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload));
  const signed = sign ? signHeaders(recipe, { raw, secret, now: at }) : {};
  const res = await fetch(`${base}/hook/psp`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed, ...headers }, body: raw });
  return { status: res.status, body: await res.json(), type: res.headers.get('content-type') };
};

const itemId = (row) => { const m = /\/OrderItem\/(\d+)/.exec(row || ''); return m ? m[1] : null; };
let annOrder = null, bobOrder = null;

export const checks = [
  { task: 'A guest browses the storefront, searches and filters without signing in',
    run: async ({ asGuest, get, rowWith, must }) => {
      asGuest();
      const { html, status } = await get('/Product');
      must(status === 200, `storefront returned ${status}`);
      must(rowWith(html, 'Blue mug') && rowWith(html, 'Mountain poster'), 'products are missing');
      must(!rowWith(html, 'Old poster'), 'an inactive product is on the storefront');
      must(html.includes('12.50'), 'price is not shown as money');
      must(!html.includes('Add to cart'), 'a guest sees the cart button');
      const s = await get('/Product?q=poster');
      must(rowWith(s.html, 'Mountain poster') && !rowWith(s.html, 'Blue mug'), 'search does not narrow');
      const f = await get('/Product?category=1');
      must(rowWith(f.html, 'Blue mug') && !rowWith(f.html, 'Mountain poster'), 'category filter does not narrow');
      return 'catalog, search, filter, money format, no cart for guests';
    } },
  { task: 'A guest is sent to login for orders and gets no dashboard',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const o = await get('/Order');
      must(o.location.startsWith('/login'), `orders did not redirect to login: ${o.status} ${o.location}`);
      const d = await get('/dashboard/sales');
      must(d.location.startsWith('/login'), 'the dashboard did not redirect to login');
      return 'redirected to /login with next=';
    } },
  { task: 'A customer registers and lands signed in; a duplicate email is refused',
    run: async ({ post, get, must, flashOf }) => {
      const r = await post('/register', { email: 'ann@shop.test', password: 'secret1', name: 'Ann' });
      must(r.status === 303, `register returned ${r.status}: ${r.html.slice(0, 300)}`);
      const home = await get(r.location);
      must(/Signed in as ann@shop.test \(customer\)/.test(home.html), 'not signed in after registering');
      must(/Welcome, ann@shop.test/.test(flashOf(home.html)), 'no welcome message');
      const dup = await post('/register', { email: 'ann@shop.test', password: 'x', name: 'Ann again' });
      must(dup.status === 400 && /already (taken|registered)/.test(dup.html), 'a duplicate email was accepted');
      return 'registered, session cookie set, duplicate refused';
    } },
  { task: 'Adding products builds a cart whose count and total are derived',
    run: async ({ get, follow, idOf, rowWith, must, flashOf }) => {
      const list = await get('/Product');
      const blue = idOf(list.html, 'Blue mug'), poster = idOf(list.html, 'Mountain poster');
      let r = await follow(`/Product/${blue}/action/addToCart`, {});
      must(/Blue mug added to your cart/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      await follow(`/Product/${blue}/action/addToCart`, {});
      r = await follow(`/Product/${poster}/action/addToCart`, { qty: 2 });
      const cart = rowWith(r.html, 'Cart');
      must(cart, 'no cart row');
      must(cart.includes('<td>4</td>'), `item count is wrong: ${cart}`);
      must(cart.includes('75.00'), `total is wrong: ${cart}`);
      annOrder = idOf(r.html, 'Cart');
      const detail = await get(`/Order/${annOrder}`);
      must(/Blue mug/.test(detail.html) && /Mountain poster/.test(detail.html), 'items are missing from the order');
      must(/<td>50\.00<\/td>/.test(detail.html), 'the line total is not derived');
      return '4 units in 3 lines, total 75.00, line totals derived';
    } },
  { task: 'A zero quantity is refused by the rule; editing a quantity updates the total',
    run: async ({ get, post, follow, rowWith, must }) => {
      const detail = await get(`/Order/${annOrder}`);
      const item = itemId(rowWith(detail.html, 'Blue mug'));
      must(item, 'no edit link on the item row');
      const bad = await post(`/OrderItem/${item}`, { qty: 0 });
      must(bad.status === 400 && /Quantity must be at least 1/.test(bad.html), 'qty 0 was accepted');
      const saved = await post(`/OrderItem/${item}`, { qty: 3 });
      must(saved.status === 303 && saved.location.startsWith(`/Order/${annOrder}`), `edit did not return to the order: ${saved.status} ${saved.location}`);
      const r = await get(saved.location);
      must(/<td>100\.00<\/td>/.test(r.html), 'the total did not follow the quantity');
      return 'rule message shown, total 100.00 after edit';
    } },
  { task: 'Placing the order takes stock, mails a confirmation and notifies fulfilment over HTTP',
    run: async ({ get, follow, rowWith, must, sink, flashOf }) => {
      sink.clear();
      const r = await follow(`/Order/${annOrder}/go/place`, { address: '1 Main st', paymentMethod: 'paypal' });
      must(new RegExp(`Order #${annOrder} placed, total 100.00`).test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/status">Placed/.test(r.html), 'status is not placed');
      must(/1 Main st/.test(r.html), 'the address was not stored with the transition');
      const products = await get('/Product');
      must(rowWith(products.html, 'Blue mug').includes('<td>6</td>'), 'stock was not decremented (10 - 4)');
      must(rowWith(products.html, 'Mountain poster').includes('<td>3</td>'), 'stock was not decremented (5 - 2)');
      must(sink.received.length === 1, `fulfilment received ${sink.received.length} call(s)`);
      const hook = sink.received[0];
      must(hook.path === '/hooks/shop' && hook.body.order === Number(annOrder) && hook.body.total === 100 && hook.body.items === 6 && hook.body.payment === 'paypal',
        `hook body ${JSON.stringify(hook.body)}`);
      return 'stock 6 and 3, webhook delivered with order, total, items, payment';
    } },
  { task: 'Paying moves the order on; the same transition is not offered twice',
    run: async ({ get, follow, post, must, flashOf }) => {
      const r = await follow(`/Order/${annOrder}/go/pay`, {});
      must(/Payment received, thank you: 100 points earned/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Net<\/th><td>100\.00<\/td>/.test(r.html), 'the plugin function discount() did not produce the net amount');
      must(/status">Paid/.test(r.html), 'status is not paid');
      must(!/go\/pay"/.test(r.html) && !/go\/place"/.test(r.html), 'a spent transition is still offered');
      const again = await post(`/Order/${annOrder}/go/pay`, {});
      must(again.status === 409, `paying twice returned ${again.status}`);
      const ship = await post(`/Order/${annOrder}/go/ship`, {});
      must(ship.status === 403, `a customer could ship: ${ship.status}`);
      return 'paid once, second pay 409, ship forbidden for customers';
    } },
  { task: 'A customer sees only their own orders and nothing of the admin surface',
    run: async ({ asGuest, post, get, rows, must }) => {
      asGuest();
      const r = await post('/register', { email: 'bob@shop.test', password: 'secret2', name: 'Bob' });
      must(r.status === 303, 'bob could not register');
      const orders = await get('/Order');
      must(rows(orders.html).length === 0, `bob sees ${rows(orders.html).length} order(s) that are not his`);
      const other = await get(`/Order/${annOrder}`);
      must(other.status === 403, `bob opened ann's order: ${other.status}`);
      must((await get('/dashboard/sales')).status === 403, 'bob opened the sales dashboard');
      must((await get('/outbox')).status === 403, 'bob opened the outbox');
      must((await get('/User')).status === 403, 'bob listed the customers');
      return 'own rows only; dashboard, outbox and users are 403';
    } },
  { task: 'Not enough stock refuses the order and rolls everything back',
    run: async ({ get, follow, post, idOf, rowWith, must, sink }) => {
      sink.clear();
      const red = idOf((await get('/Product')).html, 'Red mug');
      const cart = await follow(`/Product/${red}/action/addToCart`, { qty: 3 });
      bobOrder = idOf(cart.html, 'Cart');
      const r = await post(`/Order/${bobOrder}/go/place`, { address: '2 Side st', paymentMethod: 'card' });
      must(r.status === 400 && /Not enough stock/.test(r.html), `expected a refusal, got ${r.status}`);
      const detail = await get(`/Order/${bobOrder}`);
      must(/status">Cart/.test(detail.html), 'the status moved despite the refusal');
      must(rowWith((await get('/Product')).html, 'Red mug').includes('<td>2</td>'), 'stock changed despite the rollback');
      must(sink.received.length === 0, 'fulfilment was notified of a refused order');
      return 'refused with the rule message; status, stock and outbox untouched';
    } },
  { task: 'Cancelling a placed order returns the stock',
    run: async ({ get, follow, rowWith, must }) => {
      const detail = await get(`/Order/${bobOrder}`);
      const item = itemId(rowWith(detail.html, 'Red mug'));
      await follow(`/OrderItem/${item}`, { qty: 2 });
      let r = await follow(`/Order/${bobOrder}/go/place`, { address: '2 Side st', paymentMethod: 'card' });
      must(/status">Placed/.test(r.html), 'the corrected order was not placed');
      must(rowWith((await get('/Product')).html, 'Red mug').includes('<td>0</td>'), 'stock is not 0 after placing 2');
      r = await follow(`/Order/${bobOrder}/go/cancel`, {});
      must(/status">Cancelled/.test(r.html), 'the order is not cancelled');
      must(rowWith((await get('/Product')).html, 'Red mug').includes('<td>2</td>'), 'stock did not return after cancelling');
      return 'stock 2 → 0 → 2';
    } },
  { task: 'The admin signs in, ships the paid order and reads the outbox',
    run: async ({ asGuest, login, get, post, follow, rowWith, rows, must }) => {
      asGuest();
      const bad = await login('admin@shop.test', 'nope');
      must(bad.status === 401 && /Wrong login or password/.test(bad.html), 'a wrong password was accepted');
      const r = await login('admin@shop.test', 'admin123');
      must(r.status === 303, `admin login returned ${r.status}`);
      const orders = await get('/Order');
      must(rows(orders.html).length >= 2, 'the admin does not see every order');
      const shipped = await follow(`/Order/${annOrder}/go/ship`, {});
      must(/status">Shipped/.test(shipped.html), 'the admin could not ship');
      const outbox = await get('/outbox');
      must(outbox.status === 200, `outbox returned ${outbox.status}`);
      const mails = rows(outbox.html).filter((x) => x.includes('<td>mail</td>'));
      const hooks = rows(outbox.html).filter((x) => x.includes('<td>http</td>'));
      must(mails.length === 3, `expected 3 letters in the outbox (two orders placed, one paid), got ${mails.length}`);
      must(hooks.length === 2 && hooks.every((h) => /status">sent<\/span> 200/.test(h)), `expected 2 delivered hooks, got ${hooks.length}: ${hooks.map((h) => /status">(\w+)/.exec(h)?.[1])}`);
      must(/Order #\d+ received/.test(outbox.html) && /ann@shop.test/.test(outbox.html), 'the confirmation letter is not recorded');
      const customers = await get('/User');
      must(/ann@shop.test<\/td><td>Ann<\/td><td>customer<\/td><td>0 %<\/td><td>100<\/td>/.test(customers.html), 'the plugin field kind and the awarded points are not shown');
      const edited = await post(`/User/${/\/User\/(\d+)/.exec(rowWith(customers.html, 'ann@shop.test'))[1]}`, { discount: '150' });
      must(edited.status === 400 && /discount must be between 0 and 100/.test(edited.html), 'the plugin validation did not fire');
      return 'wrong password 401; admin ships; outbox shows 3 letters and 2 delivered hooks';
    } },
  { task: 'The sales dashboard sums derived totals and filters by period',
    run: async ({ get, must }) => {
      const d = await get('/dashboard/sales');
      must(d.status === 200, `dashboard returned ${d.status}`);
      must(/<b>100\.00<\/b>Revenue \(paid\)/.test(d.html), 'revenue does not sum the derived total of paid orders');
      must(/<b>1<\/b>Orders placed/.test(d.html), 'orders placed should count placed and later, not the cancelled one');
      must(/Shipped<\/td><td>1<\/td><td>100\.00<\/td>/.test(d.html), 'the by-status table is wrong');
      must(/Blue mug<\/td><td>4<\/td><td>50\.00<\/td>/.test(d.html), 'units by product is wrong');
      const empty = await get('/dashboard/sales?from=2000-01-01&to=2000-12-31');
      must(/<b>0<\/b>Orders placed/.test(empty.html), 'the period filter does not exclude');
      const month = new Date().toISOString().slice(0, 7);
      must(new RegExp(`${month}</td><td>2</td>`).test(d.html), 'orders by month misses the current month');
      return 'revenue 100.00, 1 placed, by status, by product, by month, period filter';
    } },
  { task: 'The payment provider\'s webhook needs a valid signature and no session: unsigned, forged, stale and tampered calls are refused',
    run: async ({ base, get, must }) => {
      const ev = { id: 'evt_forged', type: 'payment.succeeded', order: Number(annOrder), note: 'PSP_MARKER_31337' };
      const refused = { status: 401, body: { ok: false, error: 'unauthorized' } };
      const same = (r, want) => r.status === want.status && JSON.stringify(r.body) === JSON.stringify(want.body) && /^application\/json/.test(r.type);
      must(same(await hook(base, ev, { sign: false }), refused), 'an unsigned webhook was not refused');
      must(same(await hook(base, ev, { secret: 'whsec_somebody_else' }), refused), 'a webhook signed with another secret was not refused');
      must(same(await hook(base, ev, { at: Date.now() - 10 * 60_000 }), refused), 'a ten-minute-old signature was not refused');
      const good = signHeaders(recipe, { raw: Buffer.from(JSON.stringify(ev)), secret: secrets.psp_webhook, now: Date.now() });
      must(same(await hook(base, { ...ev, order: Number(annOrder) + 1 }, { sign: false, headers: good }), refused), 'a tampered body under a valid signature was not refused');
      must(same(await hook(base, ev, { headers: { 'x-psp-signature': 'sha256=' + 'ab'.repeat(5) } }), refused), 'a short signature was not refused');
      must((await fetch(`${base}/hook/psp`)).status === 405, 'GET /hook/psp is not 405');
      must((await fetch(`${base}/hook/mail`, { method: 'POST', body: '{}' })).status === 404, 'a connector without inbound answers /hook');
      must((await fetch(`${base}/hook/nowhere`, { method: 'POST', body: '{}' })).status === 404, 'an unknown connector answers /hook');
      const detail = await get(`/Order/${annOrder}`);
      must(/status">Shipped/.test(detail.html) && !detail.html.includes('PSP_MARKER_31337'), 'a refused webhook changed or was echoed into the order');
      return 'unsigned, wrong secret, stale, tampered, short: 401; GET 405; unknown connector 404; nothing changed';
    } },
  { task: 'A signed payment.succeeded pays only an order that is placed; a retry is recognised and other event types are ignored',
    run: async ({ base, get, rows, must }) => {
      const ev = { id: 'evt_cancelled', type: 'payment.succeeded', order: Number(bobOrder) };
      const first = await hook(base, ev);
      must(first.status === 200 && first.body.ok === true && !first.body.duplicate, `a signed event was answered ${first.status} ${JSON.stringify(first.body)}`);
      const again = await hook(base, ev);
      must(again.status === 200 && again.body.duplicate === true, `a retry was answered ${again.status} ${JSON.stringify(again.body)}`);
      const other = await hook(base, { id: 'evt_other', type: 'customer.created' });
      must(other.status === 200 && other.body.ignored === true, 'an event type the shop does not handle was not ignored');
      const bad = await hook(base, { id: 'evt_bad', type: 'payment.succeeded', order: 0 });
      must(bad.status === 400 && bad.body.error === 'invalid_payload', `an invalid payload was answered ${bad.status}`);
      must(/status">Cancelled/.test((await get(`/Order/${bobOrder}`)).html), 'a cancelled order was marked paid');
      const mails = rows((await get('/outbox')).html).filter((x) => x.includes('<td>mail</td>'));
      must(mails.length === 3, `the webhook of a cancelled order sent a letter: ${mails.length} in the outbox`);
      return 'cancelled order untouched, retry reported as duplicate, unknown type ignored, bad payload 400, no letter';
    } },
  navCheck(3),
  colorCheck('seashell', 'darkslateblue'),
];

// The three changes of the experiment template, applied as patches on the same database.
const retryId = (html) => { const m = /\/outbox\/(\d+)\/retry/.exec(html); return m ? m[1] : null; };
export const changes = [
  { title: 'second role with reduced access', patch: 'change-1-role.patch.json', checks: [
    { task: 'The admin creates a support user; support sees orders, ships, but edits nothing and sees no admin surface',
      run: async ({ login, post, get, follow, rows, must, asGuest }) => {
        await login('admin@shop.test', 'admin123');
        const made = await post('/User', { email: 'sam@shop.test', password: 'sam123', name: 'Sam', role: 'support' });
        must(made.status === 303, `creating the support user returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        const r = await login('sam@shop.test', 'sam123');
        must(r.status === 303, 'support could not log in');
        const orders = await get('/Order');
        must(rows(orders.html).length === 2, `support sees ${rows(orders.html).length} orders`);
        const shipped = rows(orders.html).find((x) => /status">Shipped/.test(x));
        const id = /\/Order\/(\d+)"/.exec(shipped)[1];
        const delivered = await follow(`/Order/${id}/go/deliver`, {});
        must(/status">Delivered/.test(delivered.html), 'support could not mark delivered');
        must((await get('/Product/1/edit')).status === 403, 'support opened the product editor');
        must((await post('/Product/1', { name: 'Hacked' })).status === 403, 'support edited a product');
        must((await get('/dashboard/sales')).status === 403, 'support opened the sales dashboard');
        must((await get('/outbox')).status === 403, 'support opened the outbox');
        const users = await get('/User');
        must(users.status === 200 && !/href="\/User\/new"/.test(users.html), 'support cannot list customers, or is offered to add one');
        return 'support: orders and customers read-only, deliver allowed, edit/dashboard/outbox 403';
      } },
  ] },
  { title: 'summary per customer for a period', patch: 'change-2-period.patch.json', checks: [
    { task: 'The customers report groups delivered orders by customer and narrows to a period',
      run: async ({ login, get, rows, must }) => {
        await login('admin@shop.test', 'admin123');
        const d = await get('/dashboard/customers');
        must(d.status === 200, `report returned ${d.status}`);
        must(/ann@shop.test<\/td><td>1<\/td><td>100\.00<\/td><td>100\.00<\/td>/.test(d.html), 'ann\'s row is wrong');
        must(!/bob@shop.test/.test(d.html), 'a cancelled order counts as spending');
        const empty = await get('/dashboard/customers?from=2000-01-01&to=2000-12-31');
        must(rows(empty.html).length === 0, 'the period filter does not exclude');
        return 'ann: 1 order, spent 100.00; cancelled excluded; period filter';
      } },
  ] },
  { title: 'HTTP notification with delivery status', patch: 'change-3-notify.patch.json', checks: [
    { task: 'A new product notifies analytics; a failed delivery is visible and can be retried',
      run: async ({ login, follow, get, post, rows, must, sink, flashOf }) => {
        await login('admin@shop.test', 'admin123');
        sink.clear();
        await follow('/Product', { name: 'Green mug', category: 1, price: '9.9', stock: 3 });
        const hit = sink.received.find((h) => h.path === '/hooks/analytics');
        must(hit && hit.headers['x-source'] === 'shop' && hit.body.event === 'product.created' && hit.body.name === 'Green mug' && hit.body.price === 9.9,
          `analytics got ${JSON.stringify(sink.received.map((h) => [h.path, h.body]))}`);
        sink.state.failing = true;
        await follow('/Product', { name: 'Broken mug', category: 1, price: '1', stock: 1 });
        sink.state.failing = false;
        let outbox = await get('/outbox');
        const top = rows(outbox.html)[0];
        must(/status">failed<\/span> 500/.test(top) && /HTTP 500/.test(top), `the failed delivery is not shown as failed: ${top.slice(0, 300)}`);
        const r = await follow(`/outbox/${retryId(top)}/retry`, {});
        must(/retried: sent/.test(flashOf(r.html)), `retry flash: ${flashOf(r.html)}`);
        outbox = await get('/outbox');
        must(/status">sent<\/span> 200/.test(rows(outbox.html)[0]), 'the retried delivery is not sent');
        return 'delivered with header; failure recorded as failed/500; retry → sent';
      } },
    { task: 'A placed order is paid by the provider\'s signed webhook exactly once, and the operator can send the same event from the command line',
      run: async ({ login, base, get, follow, idOf, rowWith, rows, must }) => {
        const admin = () => login('admin@shop.test', 'admin123');
        const place = async (product) => {
          await login('ann@shop.test', 'secret1');
          const cart = await follow(`/Product/${idOf((await get('/Product')).html, product)}/action/addToCart`, {});
          const id = idOf(cart.html, 'Cart');
          must(/status">Placed/.test((await follow(`/Order/${id}/go/place`, { address: '5 Fifth st', paymentMethod: 'card' })).html), `${product}: the order was not placed`);
          await admin();
          return id;
        };
        const points = async () => /ann@shop.test<\/td><td>Ann<\/td><td>customer<\/td><td>0 %<\/td><td>(\d+)<\/td>/.exec(rowWith((await get('/User')).html, 'ann@shop.test'))?.[1];
        await admin();
        const before = Number(await points());
        const order = await place('Blue mug');
        const ev = { id: 'evt_paid_1', type: 'payment.succeeded', order: Number(order) };
        const paid = await hook(base, ev);
        must(paid.status === 200 && paid.body.ok === true && !paid.body.duplicate, `the webhook was answered ${paid.status} ${JSON.stringify(paid.body)}`);
        must(/status">Paid/.test((await get(`/Order/${order}`)).html), 'the order is not paid after the webhook');
        must(Number(await points()) === before + 12, `the loyalty points did not follow the payment: ${before} -> ${await points()}`);
        const retry = await hook(base, ev);
        must(retry.body.duplicate === true, 'the provider\'s retry was not recognised');
        must(Number(await points()) === before + 12, 'the retry awarded the points twice');
        let outboxHtml = (await get('/outbox')).html;
        const letters = (id) => rows(outboxHtml).filter((x) => x.includes(`Payment for order #${id} received`)).length;
        must(letters(order) === 1, `expected one payment letter for order #${order}, got ${letters(order)}`);
        // the same event from the command line, signed with the stored secret
        const second = await place('Blue mug');
        const file = path.join(os.tmpdir(), `shop-sim-${process.pid}.json`);
        fs.writeFileSync(file, JSON.stringify({ id: 'evt_sim_1', type: 'payment.succeeded', order: Number(second) }));
        const sim = () => promisify(execFile)('node', ['--no-warnings', 'runtime/run.mjs', 'apps/shop/app.json', '--connectors', 'simulate', 'psp', 'payment.succeeded', '--data', file, '--port', new URL(base).port]);
        try {
          must((await sim()).stdout.trim() === '200 {"ok":true}', 'simulate was not accepted');
          must((await sim()).stdout.trim() === '200 {"ok":true,"duplicate":true}', 'simulate twice was not a duplicate');
        } finally { fs.rmSync(file, { force: true }); }
        must(/status">Paid/.test((await get(`/Order/${second}`)).html), 'the simulated event did not pay the order');
        outboxHtml = (await get('/outbox')).html;
        must(letters(second) === 1, `expected one payment letter for order #${second}, got ${letters(second)}`);
        return 'paid by webhook: status, 12 points, one letter; retry is a duplicate; --connectors simulate does the same, once';
      } },
  ] },
];
