// WebGen-Bench 000045 — paper cup manufacturing: raw materials, finished products, production, sales, customers, reports.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const metric = (html, title) => {
  const m = new RegExp(`<b>([\\d.\\-]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};
const stockOf = (row) => Number(/<td>(\d+)<\/td>/.exec(row)?.[1]);

export const checks = [
  { task: 'Adding a raw material lists it in the inventory with its details and a confirmation',
    run: async ({ follow, rowWith, must, flashOf }) => {
      const r = await follow('/RawMaterial', { name: 'Kraft paper roll 300gsm', unit: 'roll', stock: 40, unitCost: '18.50', supplier: 'Nordic Paper' });
      must(/Raw material added successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Kraft paper roll 300gsm');
      must(row, 'the new raw material is not in the inventory list');
      must(/<td>roll<\/td><td>40<\/td><td>18\.50<\/td><td>Nordic Paper<\/td>/.test(row), `row details are wrong: ${row}`);
      return 'listed with unit, stock 40, cost 18.50 and supplier';
    } },
  { task: 'Recording a sale deducts the quantity from finished products and shows it in the sales history',
    run: async ({ get, post, follow, idOf, rowWith, must, flashOf }) => {
      const products = await get('/Product');
      must(stockOf(rowWith(products.html, 'Hot cup 8oz')) === 5000, 'seed stock of Hot cup 8oz is not 5000');
      const product = idOf(products.html, 'Hot cup 8oz', 'Product');
      const customer = idOf((await get('/Customer')).html, 'Metro Catering', 'Customer');
      const r = await follow('/Sale', { customer, product, quantity: 300, price: '' });
      must(/Sale recorded successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Metro Catering');
      must(row && /Hot cup 8oz/.test(row) && /<td>300<\/td><td>0\.12<\/td><td>36\.00<\/td>/.test(row), `sale row: ${row}`);
      must(new RegExp(`<td>${today()}</td>`).test(row), 'the sale date is not today');
      must(stockOf(rowWith((await get('/Product')).html, 'Hot cup 8oz')) === 4700, 'stock was not deducted (5000 - 300)');
      const over = await post('/Sale', { customer, product, quantity: 999999 });
      must(over.status >= 400 && /Not enough finished products/.test(over.html), `an oversold quantity was accepted: ${over.status}`);
      must(stockOf(rowWith((await get('/Product')).html, 'Hot cup 8oz')) === 4700, 'stock changed although the sale was refused');
      must(!rowWith((await get('/Sale')).html, '999999'), 'the refused sale was recorded');
      return '300 cups at the list price 0.12 = 36.00; stock 5000 → 4700; oversell refused and rolled back';
    } },
  { task: 'Inventory tracking lists current quantities of every raw material and finished product',
    run: async ({ get, rows, rowWith, must }) => {
      const raw = await get('/RawMaterial');
      must(/<th>(?:<a[^>]*>)?Stock(?: [▲▼])?(?:<\/a>)?<\/th>/.test(raw.html) && rows(raw.html).length === 4, `raw materials list has ${rows(raw.html).length} rows`);
      must(stockOf(rowWith(raw.html, 'Paperboard 210gsm')) === 1200 && /<td>kg<\/td>/.test(rowWith(raw.html, 'Paperboard 210gsm')), 'paperboard stock or unit is wrong');
      must(/<td>450<\/td>/.test(rowWith(raw.html, 'Paperboard 210gsm')), 'material used by production is not derived (300 + 150)');
      const fin = await get('/Product');
      must(rows(fin.html).length === 3, `finished products list has ${rows(fin.html).length} rows`);
      must(stockOf(rowWith(fin.html, 'Hot cup 8oz')) === 4700 && stockOf(rowWith(fin.html, 'Cold cup 16oz')) === 2000, 'finished product stock is wrong');
      must(/<td>20000<\/td><td>1800<\/td>/.test(rowWith(fin.html, 'Hot cup 8oz')), 'produced and sold counters are not derived');
      const d = await get('/dashboard/inventory');
      must(metric(d.html, 'Finished cups in stock') === 7500, `cups in stock: ${metric(d.html, 'Finished cups in stock')}`);
      must(metric(d.html, 'Raw material units in stock') === 1335, `raw units in stock: ${metric(d.html, 'Raw material units in stock')}`);
      must(/Hot cup 8oz<\/td><td>1<\/td><td>20000<\/td><td>300<\/td>/.test(d.html), 'production by product is wrong');
      return 'per-item stock for 4 materials and 3 products; totals 7500 cups and 1335 material units';
    } },
  { task: 'The sales history report lists every transaction with customer, product and date, and narrows to a period',
    run: async ({ get, rows, must }) => {
      const all = await get('/Sale');
      const listed = rows(all.html);
      must(listed.length === 5, `expected 5 sales, got ${listed.length}`);
      must(listed.every((r) => /href="\/Customer\/\d+"/.test(r) && /href="\/Product\/\d+"/.test(r) && /<td>\d{4}-\d\d-\d\d<\/td>/.test(r)),
        'a sale row lacks the customer, product or date');
      const jan = await get('/Sale?date_from=2026-01-01&date_to=2026-01-31');
      must(rows(jan.html).length === 1 && /Bean and Leaf/.test(rows(jan.html)[0]) && /60\.00/.test(rows(jan.html)[0]), 'the date range does not narrow to January');
      const report = await get('/dashboard/sales-report');
      must(metric(report.html, 'Sales') === 5 && metric(report.html, 'Cups sold') === 2100 && metric(report.html, 'Revenue') === 252, 'report totals are wrong');
      must(/Hot cup 8oz<\/td><td>3<\/td><td>1800<\/td><td>216\.00<\/td>/.test(report.html), 'by-product row is wrong');
      must(/2026-02<\/td><td>2<\/td><td>138\.00<\/td>/.test(report.html), 'by-month row is wrong');
      const feb = await get('/dashboard/sales-report?from=2026-02-01&to=2026-02-28');
      must(metric(feb.html, 'Sales') === 2 && metric(feb.html, 'Revenue') === 138, 'the report period filter does not narrow');
      return '5 transactions with customer, product, date; January = 1 row; totals 252.00; February 138.00';
    } },
  { task: 'Adding a customer confirms it and shows the stored details on the customer page and in the list',
    run: async ({ post, get, rowWith, must, flashOf }) => {
      const made = await post('/Customer', { name: 'Riverside Cafe', email: 'hello@riverside.test', phone: '+1 555 0199', city: 'Bend' });
      must(made.status === 303 && /\/Customer\/\d+/.test(made.location), `creating a customer returned ${made.status} ${made.location}`);
      const detail = await get(made.location);
      must(/Customer added successfully/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Email<\/th><td>hello@riverside.test<\/td>/.test(detail.html) && /<th>Phone<\/th><td>\+1 555 0199<\/td>/.test(detail.html)
        && /<th>City<\/th><td>Bend<\/td>/.test(detail.html), 'customer details are not stored as entered');
      must(/<th>Purchases<\/th><td>0<\/td>/.test(detail.html) && /<th>Spent<\/th><td>0\.00<\/td>/.test(detail.html), 'derived purchase counters missing');
      const row = rowWith((await get('/Customer')).html, 'Riverside Cafe');
      must(row && /hello@riverside.test/.test(row) && /Bend/.test(row), 'the customer is not in the list with its details');
      return 'confirmed; email, phone, city on the page and in the list; 0 purchases';
    } },
  { task: 'Customer sales statistics summarise total sales and purchase frequency per customer',
    run: async ({ get, must }) => {
      const d = await get('/dashboard/customers');
      must(d.status === 200, `statistics returned ${d.status}`);
      must(metric(d.html, 'Customers') === 4 && metric(d.html, 'Revenue') === 252, 'totals are wrong');
      must(/Metro Catering<\/td><td>2<\/td><td>1300<\/td><td>156\.00<\/td>/.test(d.html), 'Metro Catering row is wrong (2 purchases, 156.00)');
      must(/Bean and Leaf<\/td><td>2<\/td><td>600<\/td><td>78\.00<\/td>/.test(d.html), 'Bean and Leaf row is wrong (2 purchases, 78.00)');
      must(/Campus Canteen<\/td><td>1<\/td><td>200<\/td><td>18\.00<\/td>/.test(d.html), 'Campus Canteen row is wrong');
      const order = ['Metro Catering', 'Bean and Leaf', 'Campus Canteen'].map((n) => d.html.indexOf(`${n}</td>`));
      must(order[0] < order[1] && order[1] < order[2], 'customers are not sorted by total sales');
      const list = await get('/Customer');
      must(/Metro Catering.*<td>2<\/td><td>156\.00<\/td>/.test(list.html), 'the customer list does not carry the derived totals');
      return 'per-customer purchases, cups and totals, sorted by total; list carries the same numbers';
    } },
  navCheck(5),
  colorCheck('lightgoldenrodyellow', 'olivedrab'),
];
