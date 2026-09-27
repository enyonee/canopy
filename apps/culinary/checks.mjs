// webgen-bench/000066 — culinary guide: restaurants, recipes, reviews and ratings.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Browse the list of nearby restaurants from the homepage',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/page/home');
      must(home.status === 200 && /href="\/Restaurant"/.test(home.html), 'the homepage does not link to restaurants');
      const { html, status } = await get('/Restaurant');
      must(status === 200, `restaurant list returned ${status}`);
      must(rows(html).length === 5, `expected 5 restaurants, got ${rows(html).length}`);
      const row = rowWith(html, 'Trattoria Solare');
      must(row && /12 Fig St|Riverton/.test(row) && /href="\/Restaurant\/\d+"/.test(row), `restaurant row: ${row}`);
      const detail = await get('/Restaurant/1');
      must(/<th>Address<\/th><td>12 Fig St<\/td>/.test(detail.html), 'the restaurant detail lacks its address');
      return '5 restaurants listed with name and address, each with a details link';
    } },

  { task: 'Perform a search for a specific recipe using the search bar',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Recipe?q=taco');
      must(status === 200, `recipe search returned ${status}`);
      must(rows(html).length === 1, `expected 1 recipe for "taco", got ${rows(html).length}`);
      const row = rowWith(html, 'Street Tacos al Pastor');
      must(row && /<td>mexican<\/td>/.test(row), `taco recipe row: ${row}`);
      const q2 = await get('/Recipe?q=chickpeas');
      must(rows(q2.html).length === 1 && rowWith(q2.html, 'Chana Masala'), 'searching by an ingredient word does not find the recipe');
      return 'searching "taco" and "chickpeas" each return the one matching recipe with a description';
    } },

  { task: "View a detailed page of a selected restaurant to see its reviews and ratings",
    run: async ({ get, must }) => {
      const { html, status } = await get('/Restaurant/1');
      must(status === 200, `restaurant detail returned ${status}`);
      must(/<th>Rating<\/th><td>5<\/td>/.test(html) && /<th>Reviews<\/th><td>2<\/td>/.test(html), `derived rating/count: ${html.slice(0, 400)}`);
      must(/<h3>Reviews<\/h3>/.test(html) && /Best pizza crust in town/.test(html) && /Great pasta, a bit slow/.test(html), 'the seeded reviews are not shown under the restaurant');
      must(/priya@culinary\.test/.test(html) && /admin@culinary\.test/.test(html), 'review authors are not shown');
      return 'Trattoria Solare shows both seeded reviews and a derived average rating of 5 from 2 reviews';
    } },

  { task: "Submit a review and rating for a restaurant you've previously visited",
    run: async ({ asGuest, post, get, follow, must, flashOf }) => {
      asGuest();
      const anon = await post('/Restaurant/2/add/Review', { stars: 3, comment: 'Should be blocked' });
      must(anon.status === 403, `a guest could post a review: ${anon.status}`);
      const reg = await post('/register', { email: 'ben@culinary.test', password: 'ben123', name: 'Ben' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const bad = await post('/Restaurant/2/add/Review', { stars: 9, comment: 'Too many stars' });
      must(bad.status === 400 && /between 1 and 5 stars/.test(bad.html), 'an out-of-range rating was accepted');
      const r = await follow('/Restaurant/2/add/Review', { stars: 2, comment: 'Service was slow tonight.' });
      must(/Your review has been posted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/Service was slow tonight\./.test(r.html) && /ben@culinary\.test/.test(r.html), 'the new review is not shown under the restaurant');
      // Golden Dragon had one seeded review (4 stars); avg(4, 2) = 3.
      must(/<th>Rating<\/th><td>3<\/td>/.test(r.html) && /<th>Reviews<\/th><td>2<\/td>/.test(r.html), `updated rating: ${r.html.slice(0, 400)}`);
      return "Ben's 2-star review is added under Golden Dragon; the average rating recalculates from 4 to 3";
    } },

  { task: 'Navigate through the site\'s main sections (home, restaurants, recipes, reviews) using the main menu',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.status === 200 && /Restaurants and recipes/.test(home.html), 'the home section did not load');
      for (const [href, text] of [['/Restaurant', 'Restaurants'], ['/Recipe', 'Recipes'], ['/Review', 'Reviews']]) {
        must(new RegExp(`href="${href}"`).test(home.html), `the main menu is missing a link to ${href}`);
        const r = await get(href);
        must(r.status === 200 && new RegExp(`<h2>${text}`).test(r.html), `${href} did not load its own section (${text})`);
      }
      return 'home, restaurants, recipes and reviews each load through the main menu with matching content';
    } },

  colorCheck('lemonchiffon', 'chocolate'),
];
