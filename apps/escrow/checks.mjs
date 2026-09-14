// WebGen-Bench 000035 — cryptocurrency escrow. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let btcId = null, ethId = null, txId = null;

export const checks = [
  { task: 'A buyer browses the products with name, price and seller',
    run: async ({ asGuest, login, get, rows, rowWith, idOf, must }) => {
      asGuest();
      const open = await get('/Product');
      must(open.status === 200 && rows(open.html).length === 4, `the product list is not public: ${open.status} with ${rows(open.html).length} rows`);
      must(!/action\/buy/.test(open.html), 'a guest is offered to buy');
      must((await login('bob@escrow.test', 'bob123')).status === 303, 'the buyer could not sign in');
      const list = await get('/Product');
      must(/<th>Name<\/th><th>Coin<\/th><th>Quantity<\/th><th>Price<\/th><th>Seller<\/th>/.test(list.html), 'the columns lack name, price or seller');
      const btc = rowWith(list.html, 'Bitcoin slice');
      must(btc && /<td>BTC<\/td><td>0\.01<\/td><td>620\.00<\/td><td><a href="\/User\/2">Sam Satoshi<\/a><\/td>/.test(btc), `the product row is wrong: ${btc}`);
      must(/action\/buy/.test(btc) && !/\/edit"/.test(btc), 'the buyer is not offered to buy, or may edit');
      must(rows((await get('/Product?coin=USDT')).html).length === 1, 'the coin filter does not narrow');
      btcId = idOf(list.html, 'Bitcoin slice', 'Product');
      ethId = idOf(list.html, 'Ether bundle', 'Product');
      return '4 products with coin, quantity, price and seller; guests browse, buyers can buy';
    } },
  { task: 'Selecting a product opens a transaction and the deposit moves the amount into the escrow account',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      let r = await follow(`/Product/${btcId}/action/buy`, {});
      const m = /Transaction #(\d+) opened for Bitcoin slice: deposit 620\.00 into escrow to fund it/.exec(flashOf(r.html));
      must(m, `no confirmation after selecting the product: ${flashOf(r.html)}`);
      txId = m[1];
      const row = rowWith(r.html, `/Transaction/${txId}"`);
      must(row && /Sam Satoshi/.test(row) && /620\.00/.test(row) && /status">Pending/.test(row) && /go\/deposit"/.test(row), `the pending transaction is wrong: ${row}`);
      r = await follow(`/Transaction/${txId}/go/deposit`, {});
      must(/620\.00 deposited into escrow for Bitcoin slice/.test(flashOf(r.html)), `the deposit was not confirmed: ${flashOf(r.html)}`);
      must(/<th>Status<\/th><td><span class="status">Funded<\/span>/.test(r.html) && /go\/confirm"/.test(r.html) && !/go\/deposit"/.test(r.html), 'the transaction is not funded');
      const d = await get('/dashboard/escrow');
      must(/<b>620\.00<\/b>In escrow/.test(d.html) && /Funded<\/td><td>1<\/td><td>620\.00<\/td>/.test(d.html), 'the escrow account does not hold the deposit');
      r = await follow(`/Product/${ethId}/action/buy`, {});
      const second = /Transaction #(\d+) opened for Ether bundle/.exec(flashOf(r.html))[1];
      const short = await post(`/Transaction/${second}/go/deposit`, {});
      must(short.status === 400 && /Insufficient wallet balance/.test(short.html), `a deposit beyond the wallet balance was accepted: ${short.status}`);
      must(/status">Pending/.test((await get(`/Transaction/${second}`)).html), 'the refused deposit changed the status');
      must(/<b>620\.00<\/b>In escrow/.test((await get('/dashboard/escrow')).html), 'the refused deposit reached the escrow account');
      return `transaction #${txId} funded, escrow holds 620.00; a second deposit beyond the 1000.00 wallet is refused`;
    } },
  { task: "A seller adds a new product and it appears at once in the seller's product list",
    run: async ({ asGuest, login, get, post, rows, rowWith, must, flashOf }) => {
      asGuest();
      must((await login('sam@escrow.test', 'sam123')).status === 303, 'the seller could not sign in');
      const form = await get('/Product/new');
      must(form.status === 200 && !/name="seller"/.test(form.html), 'the seller field is offered although it comes from the session');
      const bad = await post('/Product', { name: 'Free coins', coin: 'LTC', quantity: '1', price: '0' });
      must(bad.status === 400 && /Price must be positive/.test(bad.html), 'a zero price was accepted');
      const r = await post('/Product', { name: 'Litecoin lot', coin: 'LTC', quantity: '2', price: '150', about: 'Two whole coins' });
      must(r.status === 303, `adding the product returned ${r.status}: ${r.html.slice(0, 300)}`);
      const list = await get(r.location);
      must(/Product listed successfully/.test(flashOf(list.html)), `no confirmation: ${flashOf(list.html)}`);
      const row = rowWith(list.html, 'Litecoin lot');
      must(row && /<td>LTC<\/td><td>2<\/td><td>150\.00<\/td><td><a href="\/User\/2">Sam Satoshi<\/a>/.test(row) && /\/edit"/.test(row), `the new product row is wrong: ${row}`);
      must(rows(list.html).length === 3 && !rowWith(list.html, 'Tether pack'), "the seller's list is not limited to the seller's products");
      const sales = await get('/Transaction');
      must(rows(sales.html).length === 2 && rows(sales.html).every((x) => /Sam Satoshi/.test(x)), 'the seller does not see exactly their transaction records');
      must((await get('/User')).status === 403, 'a seller can list the users');
      return 'product listed with the session seller; seller sees 3 own products and 2 own transactions';
    } },
  { task: "Submitting a dispute marks the transaction 'disputed'; the arbiter resolves it",
    run: async ({ asGuest, login, get, post, follow, must, flashOf }) => {
      asGuest();
      await login('bob@escrow.test', 'bob123');
      const noReason = await post(`/Transaction/${txId}/go/dispute`, {});
      must(noReason.status === 400 && /reason is required/.test(noReason.html), 'a dispute without a reason was accepted');
      let r = await follow(`/Transaction/${txId}/go/dispute`, { reason: 'Coins never arrived' });
      must(/Dispute opened; the arbiter will review it/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(/<th>Status<\/th><td><span class="status">Disputed<\/span>/.test(r.html) && /<th>Reason<\/th><td>Coins never arrived<\/td>/.test(r.html), "the transaction is not 'disputed'");
      must(!/go\/refund"/.test(r.html) && !/go\/confirm"/.test(r.html), 'the buyer is offered resolution or confirmation on a disputed transaction');
      must(/Disputed<\/td><td>1<\/td><td>620\.00<\/td>/.test((await get('/dashboard/escrow')).html), 'the escrow account does not show the dispute');
      asGuest();
      await login('sam@escrow.test', 'sam123');
      must((await post(`/Transaction/${txId}/go/release`, {})).status === 409, 'the seller could release a disputed escrow');
      asGuest();
      await login('admin@escrow.test', 'admin123');
      r = await follow(`/Transaction/${txId}/go/refund`, {});
      must(/620\.00 returned to Bob Buyer/.test(flashOf(r.html)) && /status">Refunded/.test(r.html), `the arbiter could not refund: ${flashOf(r.html)}`);
      const users = await get('/User');
      must(/bob@escrow.test<\/td><td>buyer<\/td><td>1000\.00<\/td>/.test(users.html), "the buyer's wallet did not get the refund");
      return "disputed with reason; seller's release 409; arbiter refunds, wallet back to 1000.00";
    } },
  colorCheck('lightgray', 'darkred'),
];
