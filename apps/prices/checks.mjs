// WebGen-Bench 000036 — product price comparison across states.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let headphones = null, monitor = null, olive = null;
const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'Searching by category and a price parameter lists matching products with names, prices and their suppliers',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const all = await get('/Product');
      must(all.status === 200 && rows(all.html).length === 4, `catalogue shows ${rows(all.html).length} products`);
      headphones = idOf(all.html, 'Wireless headphones'); monitor = idOf(all.html, '4K monitor'); olive = idOf(all.html, 'Olive oil 1L');
      const cat = await get('/Product?category=1');
      must(rowWith(cat.html, 'Wireless headphones') && rowWith(cat.html, '4K monitor'), 'electronics are missing from the category');
      must(!rowWith(cat.html, 'Olive oil 1L') && !rowWith(cat.html, 'Cotton bath towel'), 'the category filter does not narrow');
      const narrowed = await get('/Product?category=1&lowest_to=100');
      const shown = rows(narrowed.html);
      must(shown.length === 1 && /Wireless headphones/.test(shown[0]), `category + price ceiling should leave the headphones only, got ${shown.length} row(s)`);
      must(/<td>79\.50<\/td>/.test(shown[0]), `the lowest price is not shown as money: ${shown[0]}`);
      const q = await get('/Product?q=olive');
      must(rows(q.html).length === 1 && rowWith(q.html, 'Olive oil 1L'), 'keyword search does not narrow');
      const offers = await get(`/Offer?product=${headphones}`);
      must(rows(offers.html).length === 3, `expected 3 offers for the headphones, got ${rows(offers.html).length}`);
      for (const s of ['Bay Traders', 'Lone Star Supply', 'Empire Goods']) must(rowWith(offers.html, s), `supplier ${s} is not shown`);
      return 'category + price ceiling → 1 product at 79.50; keyword search; 3 suppliers on its offers';
    } },
  { task: 'Comparing one product across states marks the lowest price with its state and supplier, and follows new offers',
    run: async ({ get, follow, rows, rowWith, must }) => {
      let cmp = await get(`/Offer?product=${monitor}`);
      let shown = rows(cmp.html);
      must(shown.length === 3, `expected 3 offers for the monitor, got ${shown.length}`);
      must(/<td>299\.00<\/td>/.test(shown[0]) && /New York/.test(shown[0]) && /Empire Goods/.test(shown[0]) && /Lowest price/.test(shown[0]),
        `the first row is not the lowest offer with its state and supplier: ${shown[0]}`);
      must(shown.slice(1).every((r) => !/Lowest price/.test(r)), 'more than one offer is marked lowest');
      must(/<td>310\.00<\/td>/.test(shown[1]) && /<td>329\.00<\/td>/.test(shown[2]), 'offers are not sorted by price');
      let detail = await get(`/Product/${monitor}`);
      must(field(detail.html, 'Lowest') === '299.00', `product lowest price is ${field(detail.html, 'Lowest')}`);
      detail = await follow(`/Product/${monitor}/add/Offer`, { state: 2, supplier: 2, price: '289', quantity: 2 });
      must(/Offer recorded/.test(detail.html), 'the new offer was not recorded');
      must(field(detail.html, 'Lowest') === '289.00', 'the lowest price did not follow the new offer');
      cmp = await get(`/Offer?product=${monitor}`);
      shown = rows(cmp.html);
      must(shown.length === 4 && /<td>289\.00<\/td>/.test(shown[0]) && /Texas/.test(shown[0]) && /Lowest price/.test(shown[0]), 'the new cheapest offer is not first and marked');
      must(!/Lowest price/.test(rowWith(cmp.html, '299.00')), 'the previous lowest offer is still marked');
      return 'lowest 299.00 in New York by Empire Goods; after a 289.00 offer in Texas the mark moves';
    } },
  { task: 'The search frequency is changed in the user settings and the saved value is shown afterwards',
    run: async ({ get, post, follow, rows, idOf, must, flashOf }) => {
      const settings = await get('/Profile');
      must(settings.status === 200 && rows(settings.html).length === 1, 'the settings page does not show the profile');
      must(/<td>daily<\/td>/.test(rows(settings.html)[0]), 'the default frequency is not daily');
      const id = idOf(settings.html, 'Shopper');
      const form = await get(`/Profile/${id}/edit`);
      must(/<select id="f_searchFrequency" name="searchFrequency">/.test(form.html) && /<option>weekly<\/option>/.test(form.html), 'the frequency is not offered as a choice');
      const bad = await post(`/Profile/${id}`, { name: 'Shopper', email: 'shopper@prices.test', searchFrequency: 'monthly' });
      must(bad.status === 400 && /searchFrequency must be one of/.test(bad.html), 'an unknown frequency was accepted');
      const saved = await follow(`/Profile/${id}`, { name: 'Shopper', email: 'shopper@prices.test', searchFrequency: 'weekly', alerts: 'on' });
      must(/Settings saved/.test(flashOf(saved.html)), `no confirmation: ${flashOf(saved.html)}`);
      must(field(saved.html, 'Search Frequency') === 'weekly' && field(saved.html, 'Alerts') === 'On', 'the new frequency is not shown on the profile');
      const again = await get('/Profile');
      must(/<td>weekly<\/td>/.test(rows(again.html)[0]), 'the settings list does not reflect the change');
      return 'daily → weekly saved, unknown value refused; no scheduler exists to run at that frequency';
    } },
  { task: 'A product page shows its details with price, quantity and supplier for every offer',
    run: async ({ get, rows, rowWith, must }) => {
      const detail = await get(`/Product/${olive}`);
      must(detail.status === 200, `product page returned ${detail.status}`);
      must(field(detail.html, 'Category') && /Grocery/.test(field(detail.html, 'Category')), 'category is missing');
      must(field(detail.html, 'About') === 'Extra virgin, cold pressed', 'the description is missing');
      must(field(detail.html, 'Lowest') === '9.90' && field(detail.html, 'Offers') === '3', 'derived lowest price / offer count are wrong');
      const offers = rows(detail.html).filter((r) => /\/Supplier\//.test(r));
      must(offers.length === 3, `expected 3 offer rows, got ${offers.length}`);
      const coastal = rowWith(detail.html, 'Coastal Market');
      must(coastal && /California/.test(coastal) && /<td>9\.90<\/td>/.test(coastal) && /<td>60<\/td>/.test(coastal) && /<td>Yes<\/td>/.test(coastal), `cheapest offer row is wrong: ${coastal}`);
      const lone = rowWith(detail.html, 'Lone Star Supply');
      must(lone && /<td>12\.40<\/td>/.test(lone) && /<td>100<\/td>/.test(lone) && /<td>No<\/td>/.test(lone), `offer row is wrong: ${lone}`);
      const supplier = await get('/Supplier/4');
      must(field(supplier.html, 'City') === 'San Diego' && /\+1 619 555 0400/.test(supplier.html), 'supplier details are missing');
      return 'lowest 9.90, 3 offers with state, supplier, price, quantity; supplier page with city and phone';
    } },
  navCheck(4),
  colorCheck('seashell', 'crimson'),
];
