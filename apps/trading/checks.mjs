// WebGen-Bench 000041 — online bidding and trading with accounts.
import { colorCheck } from '../../verify/lib.mjs';

let helio = null, accountId = null;
const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'A trader places a bid on an opportunity and it appears in the bid history with its details',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Opportunity');
      helio = idOf(list.html, 'Helio Energy shares');
      must(!/Place bid/.test((await get(`/Opportunity/${helio}`)).html), 'a guest is offered the bid form');
      must((await post(`/Opportunity/${helio}/add/Bid`, { price: '12.75', quantity: 10 })).status === 403, 'a guest could bid');
      must((await login('mia@trading.test', 'mia123')).status === 303, 'mia could not sign in');
      const zero = await post(`/Opportunity/${helio}/add/Bid`, { price: '12.75', quantity: 0 });
      must(zero.status === 400 && /Quantity must be between 1 and the units offered/.test(zero.html), 'a zero quantity was accepted');
      const page = await follow(`/Opportunity/${helio}/add/Bid`, { price: '12.75', quantity: 10 });
      must(/Bid placed/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      const row = rowWith(page.html, 'mia@trading.test');
      must(row && /<td>12\.75<\/td>/.test(row) && /<td>10<\/td>/.test(row) && /<td>127\.50<\/td>/.test(row) && /status">Placed/.test(row), `bid row: ${row}`);
      const history = await get('/list/history');
      const mine = rowWith(history.html, 'Helio Energy shares');
      must(mine && /127\.50/.test(mine) && /status">Placed/.test(mine) && /\d{4}-\d{2}-\d{2}T/.test(mine), `history row: ${mine}`);
      const closed = idOf(list.html, 'Marisol Retail shares');
      const late = await post(`/Opportunity/${closed}/add/Bid`, { price: '9', quantity: 1 });
      must(late.status === 400 && /This opportunity is closed/.test(late.html), 'a bid on a closed opportunity was accepted');
      const big = await post(`/Opportunity/${helio}/add/Bid`, { price: '100', quantity: 100 });
      must(big.status === 400 && /exceeds the risk limit/.test(big.html), 'a bid beyond the risk limit was accepted');
      return 'guest refused; 10 x 12.75 = 127.50 placed and in the history; closed and over-limit bids refused';
    } },
  { task: 'The available trading opportunities are listed completely with their details',
    run: async ({ get, rows, rowWith, must }) => {
      const list = await get('/Opportunity');
      const shown = rows(list.html);
      must(shown.length === 5, `expected 5 opportunities, got ${shown.length}`);
      for (const t of ['Helio Energy shares', 'Northwind 2030 bond', 'Copper futures lot', 'Bitcoin block', 'Marisol Retail shares']) must(rowWith(list.html, t), `${t} is missing`);
      const h = rowWith(list.html, 'Helio Energy shares');
      must(/<td>stock<\/td>/.test(h) && /<td>12\.50<\/td>/.test(h) && /<td>500<\/td>/.test(h) && /2026-10-15/.test(h) && /status">Open/.test(h), `opportunity row: ${h}`);
      must(/<td>2<\/td><td>12\.75<\/td>/.test(h), 'bid count and best bid are not derived');
      const crypto = rows((await get('/Opportunity?kind=crypto')).html);
      must(crypto.length === 1 && /Bitcoin block/.test(crypto[0]), 'the kind filter does not narrow');
      must(rows((await get('/Opportunity?status=open')).html).length === 4, 'the status filter does not narrow');
      must(rows((await get('/Opportunity?q=bond')).html).length === 1, 'search does not narrow');
      return '5 opportunities with kind, ask, units, closing date, status, bids and best bid; filters and search';
    } },
  { task: 'The account dashboard shows the trading history with dates and details',
    run: async ({ get, rows, rowWith, must }) => {
      const d = await get('/dashboard/account');
      must(d.status === 200, `dashboard returned ${d.status}`);
      must(/<b>1<\/b>Open bids/.test(d.html) && /<b>127\.50<\/b>Committed/.test(d.html), 'open bids / committed are wrong');
      must(/<b>1<\/b>Trades won/.test(d.html) && /<b>850\.00<\/b>Bought/.test(d.html), 'accepted trades are wrong');
      must(/Accepted<\/td><td>1<\/td><td>850\.00<\/td>/.test(d.html) && /Rejected<\/td><td>1<\/td><td>400\.00<\/td>/.test(d.html), 'bids by status are wrong');
      must(/2026-08<\/td><td>2<\/td>/.test(d.html), 'bids by month misses August');
      const aug = await get('/dashboard/account?from=2026-08-01&to=2026-08-31');
      must(/<b>0<\/b>Open bids/.test(aug.html) && /<b>1<\/b>Trades won/.test(aug.html), 'the period filter does not narrow');
      const history = await get('/list/history');
      const shown = rows(history.html);
      must(shown.length === 3, `expected 3 own bids in the history, got ${shown.length}`);
      must(!/leo@trading\.test/.test(history.html), 'another trader\'s bids leaked into the history');
      const won = rowWith(history.html, '850.00');
      must(won && /Marisol Retail shares/.test(won) && /2026-08-20/.test(won) && /status">Accepted/.test(won), `the accepted trade is wrong: ${won}`);
      must(rowWith(history.html, '400.00') && /status">Rejected/.test(rowWith(history.html, '400.00')), 'the rejected bid is missing');
      must(/Helio Energy shares/.test(shown[0]), 'the history is not newest first');
      return 'cards 1 open / 127.50 committed / 1 won; by status and month; history of 3 own bids with dates';
    } },
  { task: 'Account information is updated on the account page, confirmed and shown afterwards',
    run: async ({ get, post, follow, rows, idOf, must, flashOf }) => {
      const accounts = await get('/Account');
      must(accounts.status === 200 && rows(accounts.html).length === 1, `the trader sees ${rows(accounts.html).length} account(s)`);
      accountId = idOf(accounts.html, 'Main account');
      const form = await get(`/Account/${accountId}/edit`);
      must(/<select id="f_currency" name="currency">/.test(form.html) && /name="riskLimit"/.test(form.html) && !/name="trader"/.test(form.html), 'the account form is wrong');
      const page = await follow(`/Account/${accountId}`, { name: 'Growth account', currency: 'EUR', phone: '+1 415 555 0199', riskLimit: '8000' });
      must(/Account information updated/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(field(page.html, 'Name') === 'Growth account' && field(page.html, 'Currency') === 'EUR' && field(page.html, 'Phone') === '+1 415 555 0199' && field(page.html, 'Risk Limit') === '8000.00', 'the changes are not shown');
      must(/Growth account/.test(rows((await get('/Account')).html)[0]), 'the account list does not reflect the change');
      must((await get('/Account/2')).status === 403 && (await post('/Account/2', { name: 'Hijacked' })).status === 403, 'another trader\'s account is reachable');
      const bigger = await post(`/Opportunity/${helio}/add/Bid`, { price: '100', quantity: 40 });
      must(bigger.status === 303, `a bid within the raised limit was refused: ${bigger.status}`);
      return 'name, currency, phone, risk limit saved and shown; other accounts 403; the new limit applies to bids';
    } },
  colorCheck('lemonchiffon', 'chocolate'),
];
