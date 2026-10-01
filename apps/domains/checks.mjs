// WebGen-Bench 000039 — domain leasing with accounts, orders and payments.
import { colorCheck } from '../../verify/lib.mjs';

// Dates come from the real clock: a literal year turns into a time bomb (the rule needs a future expiry).
const DAY = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const LEASE = DAY(365), RENEW = DAY(730);
let bright = null, northwind = null, eliId = null;
const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'Searching a known domain name returns exactly that domain with its availability',
    run: async ({ asGuest, get, rows, idOf, must }) => {
      asGuest();
      const leased = await get('/Domain?q=northwind.com');
      must(leased.status === 200 && rows(leased.html).length === 1, `expected 1 row for northwind.com, got ${rows(leased.html).length}`);
      must(/northwind\.com/.test(rows(leased.html)[0]) && /status">Leased/.test(rows(leased.html)[0]) && /2099-10-01/.test(rows(leased.html)[0]), 'the leased domain does not show its status and expiry');
      northwind = idOf(leased.html, 'northwind.com');
      const free = await get('/Domain?q=bright.io');
      must(rows(free.html).length === 1 && /status">Available/.test(rows(free.html)[0]) && /<td>12\.00<\/td>/.test(rows(free.html)[0]), 'the available domain does not show as available with its price');
      bright = idOf(free.html, 'bright.io');
      must(rows((await get('/Domain?q=nothing.zzz')).html).length === 0, 'an unknown name still lists domains');
      return 'northwind.com → leased until 2099-10-01; bright.io → available at 12.00; unknown → nothing';
    } },
  { task: 'A customer leases an available domain, gets a confirmation, sees it in the leasing records and pays the order',
    run: async ({ asGuest, login, get, post, follow, rowWith, idOf, must, flashOf }) => {
      asGuest();
      must((await post(`/Domain/${bright}/go/lease`, { expiresAt: LEASE })).status === 403, 'a guest could lease');
      must((await login('dana@domains.test', 'dana123')).status === 303, 'dana could not sign in');
      const noDate = await post(`/Domain/${bright}/go/lease`, {});
      must(noDate.status === 400 && /expiresAt is required/.test(noDate.html), 'leasing without an expiry date was accepted');
      const page = await follow(`/Domain/${bright}/go/lease`, { expiresAt: LEASE });
      must(new RegExp(`Leased until ${LEASE} — order #\\d+ is waiting for payment`).test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<h2>bright\.io<\/h2>/.test(page.html), 'the confirmation did not land on the leased domain');
      must(/status">Leased/.test(page.html) && /dana@domains\.test/.test(field(page.html, 'Holder')) && field(page.html, 'Expires At') === LEASE, 'the domain is not leased to dana');
      must((await post(`/Domain/${bright}/go/lease`, { expiresAt: DAY(400) })).status === 409, 'a leased domain could be leased again');
      const mine = await get('/list/my-domains');
      must(rowWith(mine.html, 'bright.io') && rowWith(mine.html, 'northwind.com') && !rowWith(mine.html, 'oldlace.shop'), 'the leasing records are wrong');
      const orders = await get('/Order');
      const order = rowWith(orders.html, 'bright.io');
      must(order && /<td>lease<\/td>/.test(order) && /<td>12\.00<\/td>/.test(order) && /status">Unpaid/.test(order), `the lease order is wrong: ${order}`);
      const paid = await follow(`/Order/${idOf(orders.html, 'bright.io', 'Order')}/go/pay`, { method: 'paypal' });
      must(/Order #\d+ paid by paypal: 12\.00/.test(flashOf(paid.html)) && /status">Paid/.test(paid.html), `payment failed: ${flashOf(paid.html)}`);
      return 'guest 403; date required; leased with confirmation; in My domains; order 12.00 paid by paypal';
    } },
  { task: 'A lease close to expiry is renewed by its holder only, and the new expiry shows in the records',
    run: async ({ asGuest, login, get, post, follow, rowWith, must, flashOf }) => {
      asGuest();
      await login('eli@domains.test', 'eli123');
      const other = await post(`/Domain/${northwind}/go/renew`, { expiresAt: RENEW });
      must(other.status === 400 && /Only the current holder can renew this domain/.test(other.html), `another customer could renew: ${other.status}`);
      must(field((await get(`/Domain/${northwind}`)).html, 'Expires At') === '2099-10-01', 'the refused renewal changed the expiry');
      asGuest();
      await login('dana@domains.test', 'dana123');
      const past = await post(`/Domain/${northwind}/go/renew`, { expiresAt: '2020-01-01' });
      must(past.status === 400 && /The expiry date must be in the future/.test(past.html), 'a past expiry was accepted');
      const page = await follow(`/Domain/${northwind}/go/renew`, { expiresAt: RENEW });
      must(new RegExp(`Lease renewed until ${RENEW} — order #\\d+ is waiting for payment`).test(flashOf(page.html)) && /<h2>northwind\.com<\/h2>/.test(page.html), `flash: ${flashOf(page.html)}`);
      must(field(page.html, 'Expires At') === RENEW && field(page.html, 'Renewals') === '1' && /status">Leased/.test(page.html), 'the renewed domain is wrong');
      const mine = await get('/list/my-domains');
      must(rowWith(mine.html, 'northwind.com').includes(RENEW), 'the leasing records do not show the new expiry');
      const orders = await get('/Order');
      const renewal = rowWith(orders.html, 'renewal');
      must(renewal && /northwind\.com/.test(renewal) && /<td>15\.00<\/td>/.test(renewal), `no renewal order: ${renewal}`);
      return `eli refused and nothing changed; past date refused; dana renewed to ${RENEW}, renewal order 15.00`;
    } },
  { task: 'A domain is transferred to another account; both accounts are notified and their records change',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, must, flashOf }) => {
      const detail = await get(`/Domain/${bright}`);
      const opt = /<option value="(\d+)"[^>]*>eli@domains\.test<\/option>/.exec(detail.html);
      must(opt && new RegExp(`action="/Domain/${bright}/go/transfer"`).test(detail.html), 'the transfer form does not offer other accounts');
      eliId = opt[1];
      const r = await post(`/Domain/${bright}/go/transfer`, { transferTo: eliId });
      must(r.status === 303 && r.location.startsWith('/list/my-domains'), `transfer returned ${r.status} ${r.location}`);
      const mine = await get(r.location);
      must(/Domain transferred — order #\d+ records the transfer fee/.test(flashOf(mine.html)), `flash: ${flashOf(mine.html)}`);
      must(!rowWith(mine.html, 'bright.io') && rowWith(mine.html, 'northwind.com'), 'dana still holds the transferred domain');
      const transferOrder = rowWith((await get('/Order')).html, 'transfer');
      must(transferOrder && /bright\.io/.test(transferOrder) && /<td>5\.00<\/td>/.test(transferOrder), 'no transfer order was recorded');
      asGuest();
      await login('eli@domains.test', 'eli123');
      const his = await get(`/Domain/${bright}`);
      must(/eli@domains\.test/.test(field(his.html, 'Holder')) && field(his.html, 'Transfers') === '1' && field(his.html, 'Expires At') === LEASE, 'eli is not the holder');
      must(rowWith((await get('/list/my-domains')).html, 'bright.io'), 'the domain is not in the receiver\'s records');
      const back = await post(`/Domain/${bright}/go/transfer`, { transferTo: '2' });
      must(back.status === 303, 'the new holder cannot transfer the domain on');
      asGuest();
      await login('admin@domains.test', 'admin123');
      const outbox = await get('/outbox');
      const letters = rows(outbox.html).filter((x) => x.includes('<td>mail</td>') && /bright\.io was transferred to you|You transferred bright\.io/.test(x));
      must(letters.length === 4, `expected 4 transfer letters (two per transfer), got ${letters.length}`);
      must(letters.some((x) => /<td>dana@domains\.test<\/td>/.test(x) && /You transferred bright\.io/.test(x)), 'the sender was not notified');
      must(letters.some((x) => /<td>eli@domains\.test<\/td>/.test(x) && /bright\.io was transferred to you/.test(x)), 'the receiver was not notified');
      return 'dana → eli: holder changed, records moved, order 5.00; letters to both in the outbox; eli transferred it back';
    } },
  { task: 'The order history lists every past transaction: leases, renewals and transfers',
    run: async ({ asGuest, login, get, rows, rowWith, must }) => {
      asGuest();
      await login('dana@domains.test', 'dana123');
      const orders = await get('/Order');
      must(orders.status === 200, `orders returned ${orders.status}`);
      const shown = rows(orders.html);
      must(shown.length === 4, `dana should see 4 orders (seeded lease, lease, renewal, transfer), got ${shown.length}`);
      must(shown.every((r) => /dana@domains\.test/.test(r)), 'orders of another customer leaked in');
      for (const kind of ['lease', 'renewal', 'transfer']) must(shown.some((r) => r.includes(`<td>${kind}</td>`)), `no ${kind} in the history`);
      must(shown.some((r) => /2025-10-01/.test(r) && /status">Paid/.test(r)), 'the seeded past lease is missing');
      must(rows((await get('/Order?kind=renewal')).html).length === 1, 'the kind filter does not narrow');
      must(!/href="\/Order\/new"/.test(orders.html), 'orders can be typed in by hand');
      asGuest();
      await login('admin@domains.test', 'admin123');
      const d = await get('/dashboard/payments');
      must(/<b>3<\/b>Unpaid orders/.test(d.html) && /<b>47\.00<\/b>Revenue/.test(d.html) && /<b>3<\/b>Leased domains/.test(d.html), `the payments dashboard is wrong: ${[...d.html.matchAll(/<div class="metric">(.*?)<\/div>/g)].map((m) => m[1])}`);
      must(/Lease<\/td><td>3<\/td><td>47\.00<\/td>/.test(d.html) && /Transfer<\/td><td>2<\/td><td>10\.00<\/td>/.test(d.html) && /Renewal<\/td><td>1<\/td><td>15\.00<\/td>/.test(d.html), 'orders by kind are wrong');
      must(rows((await get('/Order')).html).length === 6, 'the admin does not see every order');
      return 'dana: 4 orders of all three kinds, own only; admin dashboard 3 unpaid, revenue 47.00, 6 orders';
    } },
  colorCheck('oldlace', 'rosybrown'),
];
