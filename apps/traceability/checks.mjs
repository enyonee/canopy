// WebGen-Bench 000044 — supply chain traceability: registration, tracking, inquiry, verification, statistics.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
// The rows of one related table on a detail page (the section under its <h3>).
const sectionRows = (html, title) => {
  const part = html.split(`<h3>${title}</h3>`)[1];
  if (!part) throw new Error(`section "${title}" is missing`);
  return [...part.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
};
const metric = (html, title) => {
  const m = new RegExp(`<b>([\\d.\\-]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};
let newProduct = null;

export const checks = [
  { task: 'Registering a product with valid details confirms it and shows its unique product ID',
    run: async ({ get, post, follow, idOf, must, flashOf }) => {
      const producers = await get('/Producer');
      const producer = idOf(producers.html, 'Green Valley Farms', 'Producer');
      const made = await post('/Product', { code: 'TRC-0005', name: 'Cold-pressed olive oil', producer, origin: 'Lucca, Tuscany', category: 'food' });
      must(made.status === 303, `registering returned ${made.status}: ${made.html.slice(0, 200)}`);
      newProduct = /\/Product\/(\d+)/.exec(made.location)?.[1];
      must(newProduct, `did not land on the product page: ${made.location}`);
      const r = await get(made.location);
      must(/Product registered successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Code<\/th><td>TRC-0005<\/td>/.test(r.html), 'the product ID is not shown with the confirmation');
      must(/status">Registered/.test(r.html) && /<th>Location<\/th><td>Lucca, Tuscany<\/td>/.test(r.html), 'a new product does not start registered at its origin');
      const path = sectionRows(r.html, 'Circulation path');
      must(path.length === 1 && /registered/.test(path[0]) && /Lucca, Tuscany/.test(path[0]), 'registration did not record the first checkpoint');
      const dup = await post('/Product', { code: 'TRC-0005', name: 'Copy', producer, origin: 'Nowhere', category: 'food' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate product ID was accepted');
      return `registered as TRC-0005 (#${newProduct}), first checkpoint at origin, duplicate ID refused`;
    } },
  { task: 'Tracking by product ID shows the circulation path checkpoint by checkpoint',
    run: async ({ get, idOf, rows, must }) => {
      const found = await get('/list/track?q=TRC-0001');
      must(rows(found.html).length === 1 && rows(found.html)[0].includes('TRC-0001'), `tracking by ID returned ${rows(found.html).length} row(s)`);
      const id = idOf(found.html, 'TRC-0001', 'Product');
      const detail = await get(`/Product/${id}`);
      must(/<th>Checkpoints<\/th><td>4<\/td>/.test(detail.html), 'checkpoint count is not derived');
      const path = sectionRows(detail.html, 'Circulation path');
      const locations = path.map((r) => /<td>[a-z]+<\/td><td>([^<]+)<\/td>/.exec(r)?.[1]);
      must(JSON.stringify(locations) === JSON.stringify(['Salinas, California', 'Port of Oakland', 'Tacoma warehouse', 'Fresh Mart, Seattle']),
        `path is ${JSON.stringify(locations)}`);
      must(path.every((r) => /<td>2026-07-\d\dT/.test(r)), 'checkpoints have no timestamps');
      return 'four checkpoints in order, each with a location and a time';
    } },
  { task: 'Inquiry by product ID shows the current status with its location and time, and follows a new checkpoint',
    run: async ({ get, post, follow, idOf, rowWith, must }) => {
      let list = await get('/Product?q=TRC-0002');
      let row = rowWith(list.html, 'TRC-0002');
      must(row && /status">Shipped/.test(row) && /Hamburg port/.test(row), `current status row: ${row}`);
      const id = idOf(list.html, 'TRC-0002', 'Product');
      const wrong = await post(`/Product/${id}/go/sell`, { location: 'x' });
      must(wrong.status === 409, `selling a shipped product returned ${wrong.status}`);
      const r = await follow(`/Product/${id}/go/store`, { location: 'Rotterdam warehouse' });
      must(/status">Stored/.test(r.html) && /<th>Location<\/th><td>Rotterdam warehouse<\/td>/.test(r.html), 'the status or location did not move');
      must(new RegExp(`<th>Updated At</th><td>${today()}T`).test(r.html), 'the update time was not recorded');
      must(sectionRows(r.html, 'Circulation path').length === 3, 'the new checkpoint is not on the path');
      list = await get('/Product?q=TRC-0002');
      row = rowWith(list.html, 'TRC-0002');
      must(/status">Stored/.test(row) && /Rotterdam warehouse/.test(row), 'the inquiry does not show the new status');
      return 'shipped at Hamburg → stored at Rotterdam with today\'s time; 409 on a skipped stage';
    } },
  { task: 'Verification of a product ID confirms authenticity and shows the registered source',
    run: async ({ get, follow, idOf, must, flashOf }) => {
      const id = idOf((await get('/Product?q=TRC-0001')).html, 'TRC-0001', 'Product');
      const ok = await follow('/Verification', { code: 'TRC-0001', product: id });
      must(/Verification complete/.test(flashOf(ok.html)), `flash: ${flashOf(ok.html)}`);
      must(/<th>Authentic<\/th><td>Authentic<\/td>/.test(ok.html), 'a genuine ID was not confirmed');
      must(/<th>Producer Name<\/th><td>Green Valley Farms<\/td>/.test(ok.html) && /<th>Origin<\/th><td>Salinas, California<\/td>/.test(ok.html),
        'the registered source is not shown');
      const fake = await follow('/Verification', { code: 'TRC-9999', product: id });
      must(/<th>Authentic<\/th><td>Not authentic<\/td>/.test(fake.html), 'a wrong ID was confirmed as authentic');
      return 'TRC-0001 authentic with producer and origin; TRC-9999 not authentic';
    } },
  { task: 'The statistics page shows totals, statuses and breakdowns, and narrows by registration period',
    run: async ({ get, must }) => {
      const d = await get('/dashboard/stats');
      must(d.status === 200, `statistics returned ${d.status}`);
      must(metric(d.html, 'Products tracked') === 5, `products tracked: ${metric(d.html, 'Products tracked')}`);
      must(metric(d.html, 'In circulation') === 1 && metric(d.html, 'Delivered or sold') === 2, 'circulation counters are wrong');
      must(metric(d.html, 'Checkpoints recorded') === 13, `checkpoints: ${metric(d.html, 'Checkpoints recorded')}`);
      must(metric(d.html, 'Verifications') === 3 && metric(d.html, 'Confirmed authentic') === 2, 'verification counters are wrong');
      must(/Stored<\/td><td>1<\/td>/.test(d.html) && /Registered<\/td><td>2<\/td>/.test(d.html), 'products by status is wrong');
      must(/Green Valley Farms<\/td><td>3<\/td>/.test(d.html), 'products by producer is wrong');
      must(/2026-08<\/td><td>2<\/td>/.test(d.html), 'registrations by month is wrong');
      const aug = await get('/dashboard/stats?from=2026-08-01&to=2026-08-31');
      must(metric(aug.html, 'Products tracked') === 2, 'the period filter does not narrow');
      return '5 products, 1 in circulation, 13 checkpoints, 3 verifications; by status, producer, month; August = 2';
    } },
  navCheck(5),
  colorCheck('mistyrose', 'firebrick'),
];
