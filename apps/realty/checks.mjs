// WebGen-Bench 000034 — real estate listings. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

const TITLES = ['Sunny 3-bedroom apartment in Midtown', 'Cosy one-bedroom studio', 'Family house with garden', 'Renovated 3-bedroom apartment near the park',
  'Downtown condo with river view', 'Building plot on the hill', '3-bedroom apartment for rent'];
let firstId = null;

export const checks = [
  { task: 'The "Property Listings" menu link shows every property in the database',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      const link = /<a href="(\/Property)">Property Listings<\/a>/.exec(nav);
      must(link, 'the menu has no "Property Listings" link');
      const list = await get(link[1]);
      must(list.status === 200 && /<h2>Property Listings<\/h2>/.test(list.html), `listings returned ${list.status}`);
      must(rows(list.html).length === TITLES.length, `expected ${TITLES.length} properties, got ${rows(list.html).length}`);
      for (const t of TITLES) must(rowWith(list.html, t), `"${t}" is not listed`);
      const sunny = rowWith(list.html, TITLES[0]);
      must(/12 Oak ave, Midtown/.test(sunny) && /<td>apartment<\/td>/.test(sunny) && /<td>sale<\/td>/.test(sunny) && /275000\.00/.test(sunny) && /<td>3<\/td><td>2<\/td><td>110<\/td>/.test(sunny), `the listing row lacks details: ${sunny}`);
      must(/7 item\(s\)/.test(list.html), 'the item count is wrong');
      return '7 properties with address, type, listing, price, rooms and area';
    } },
  { task: 'The first property opens a details page with address, price, features and a photograph',
    run: async ({ get, upload, rows, must, flashOf }) => {
      const list = await get('/Property');
      const first = rows(list.html)[0];
      must(/Sunny 3-bedroom apartment in Midtown/.test(first), `the first listing is not the newest: ${first.slice(0, 120)}`);
      firstId = /\/Property\/(\d+)"/.exec(first)[1];
      const up = await upload(`/Property/${firstId}`, {}, { field: 'photo', name: 'front.jpg', content: 'JFIF-not-really-a-photo' });
      must(up.status === 303, `attaching the photograph returned ${up.status}: ${up.html.slice(0, 200)}`);
      const detail = await get(`/Property/${firstId}`);
      must(detail.status === 200 && /<h2>Sunny 3-bedroom apartment in Midtown<\/h2>/.test(detail.html), `the details page returned ${detail.status}`);
      for (const pair of ['<th>Address</th><td>12 Oak ave, Midtown</td>', '<th>Price</th><td>275000.00</td>', '<th>Bedrooms</th><td>3</td>', '<th>Bathrooms</th><td>2</td>',
        '<th>Area</th><td>110</td>', '<th>Year Built</th><td>2005</td>', '<th>Listed At</th><td>2026-09-10</td>'])
        must(detail.html.includes(pair), `the details lack ${pair}`);
      must(/Features: lift, parking space, storage room/.test(detail.html), 'the features are not described');
      const photo = new RegExp(`<th>Photo</th><td><a href="(/file/Property/${firstId}/photo)">front.jpg</a></td>`).exec(detail.html);
      must(photo, 'the photograph is not shown on the details page');
      const file = await get(photo[1]);
      must(file.status === 200 && /front.jpg/.test(file.disposition) && file.html === 'JFIF-not-really-a-photo', 'the photograph does not download');
      return 'address, price, rooms, area, year, features and a downloadable photo';
    } },
  { task: 'Searching "3-bedroom apartment" returns only the properties described that way',
    run: async ({ get, rows, rowWith, must }) => {
      const r = await get('/Property?q=' + encodeURIComponent('3-bedroom apartment'));
      must(r.status === 200 && /value="3-bedroom apartment"/.test(r.html), 'the search box does not keep the term');
      const shown = rows(r.html);
      must(shown.length === 3, `expected 3 results, got ${shown.length}`);
      for (const t of [TITLES[0], TITLES[3], TITLES[6]]) must(rowWith(r.html, t), `"${t}" is missing from the results`);
      must(!rowWith(r.html, 'Family house with garden') && !rowWith(r.html, 'Downtown condo with river view'), 'an unrelated property is in the results');
      must(rows((await get('/Property?q=lighthouse')).html).length === 0, 'a term matching nothing still returns rows');
      return '3 matching properties, the rest excluded';
    } },
  { task: 'Filtering by a price range of $200,000 to $300,000 keeps only the properties priced within it',
    run: async ({ get, rows, rowWith, must }) => {
      const list = await get('/Property');
      must(/name="price_from"/.test(list.html) && /name="price_to"/.test(list.html), 'there is no price range filter');
      const r = await get('/Property?price_from=200000&price_to=300000');
      const shown = rows(r.html);
      must(shown.length === 2, `expected 2 properties in range, got ${shown.length}`);
      must(rowWith(r.html, TITLES[0]) && rowWith(r.html, TITLES[3]), 'a property within the range is missing');
      must(!rowWith(r.html, 'Downtown condo with river view') && !rowWith(r.html, 'Building plot on the hill'), 'a property outside the range is listed');
      const rent = await get('/Property?listing=rent');
      must(rows(rent.html).length === 2 && rows(rent.html).every((x) => /<td>rent<\/td>/.test(x)), 'the listing filter does not narrow to rentals');
      const both = await get('/Property?type=apartment&price_from=200000&price_to=300000');
      must(rows(both.html).length === 2, 'type and price filters do not combine');
      return 'price 275000 and 235000 kept; 320000, 150000 and rentals excluded; filters combine';
    } },
  { task: 'The navigation menu leads back to the home page without errors',
    run: async ({ get, must }) => {
      const detail = await get(`/Property/${firstId}`);
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(detail.html)[1];
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      must(hrefs.includes('/Property'), `the menu on the details page has no home link: ${hrefs}`);
      const home = await get('/');
      must(home.location === '/Property' && home.status === 200 && /<h2>Property Listings<\/h2>/.test(home.html), `the home page redirected to ${home.location} with ${home.status}`);
      for (const h of hrefs) must((await get(h)).status === 200, `menu item ${h} fails`);
      return 'home redirects to the listings; every menu item answers 200';
    } },
  colorCheck('aliceblue', 'steelblue'),
];
