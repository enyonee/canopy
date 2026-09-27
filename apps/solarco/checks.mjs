// WebGen-Bench 000016 — solar company brochure site: intro, products, news, contact, nav.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigating to the Company Introduction page shows history, mission and values',
    run: async ({ get, must }) => {
      const { html, status } = await get('/page/company');
      must(status === 200, `Company Introduction returned ${status}`);
      must(/History/.test(html) && /2014/.test(html), 'no history section');
      must(/Mission/.test(html), 'no mission section');
      must(/Values/.test(html) && /25-year warranty/.test(html), 'no values section');
      return 'history, mission and values all present';
    } },
  { task: 'Navigating to the Product Showcase and opening the first product shows accurate specs and an image',
    run: async ({ get, idOf, must }) => {
      const list = await get('/Product');
      must(list.status === 200 && /SunPeak 400W Monocrystalline Panel/.test(list.html), 'product showcase did not list products');
      const id = idOf(list.html, 'SunPeak 400W Monocrystalline Panel');
      const { html, status } = await get(`/Product/${id}`);
      must(status === 200, `product detail returned ${status}`);
      must(/400W, 21\.5% efficiency/.test(html), 'specifications are not shown');
      must(/249\.00/.test(html), 'price is not shown');
      must(/photo: matte-black panel/.test(html), 'no product image/photo shown');
      return 'first product detail shows specs, price and photo caption';
    } },
  { task: 'Accessing News and Updates lists articles newest first with correct dates and details',
    run: async ({ get, rows, must }) => {
      const { html, status } = await get('/NewsItem');
      must(status === 200, `News and Updates returned ${status}`);
      const items = rows(html);
      must(items.length === 3, `expected 3 news items, got ${items.length}`);
      must(/2026-09-10/.test(items[0]) && /Riverside Clean Energy Fair/.test(items[0]), 'the newest article is not first');
      must(/2026-08-01/.test(items[2]), 'the oldest article is not last');
      return 'three articles, newest (2026-09-10) first, oldest last';
    } },
  { task: 'Filling in and submitting the Contact Us form with valid details succeeds with a confirmation',
    run: async ({ get, follow, must, flashOf }) => {
      const contact = await get('/ContactMessage');
      must(/hello@sunpeak\.test/.test(contact.html), 'contact info is missing');
      const r = await follow('/ContactMessage', { name: 'Tomas Reyes', email: 'tomas@example.test', message: 'Interested in a 10kWh PowerWall quote for a 3-bedroom home.' });
      must(r.status === 200, `contact submission returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/will respond soon/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(/Tomas Reyes/.test(r.html), 'the message was not recorded');
      return 'message recorded with a confirmation';
    } },
  { task: 'The main navigation moves smoothly between Company Introduction, Product Showcase, News and Contact Us and back',
    run: async ({ get, must }) => {
      const home = await get('/page/company');
      const hrefs = ['/page/company', '/Product', '/NewsItem', '/ContactMessage'];
      for (const h of hrefs) must(new RegExp(`href="${h.replace(/\//g, '\\/')}"`).test(home.html), `nav is missing a link to ${h}`);
      for (const h of hrefs) must((await get(h)).status === 200, `${h} did not load`);
      must((await get('/page/company')).status === 200, 'returning to the homepage failed');
      return 'all four sections reachable and return to the homepage works';
    } },
  colorCheck('lemonchiffon', 'chocolate'),
];
