// WebGen-Bench 000027 — a community deals board: browse, search, share a
// promotion, navigate the site, and an admin backend over users.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: "Browse the website's promotions section",
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/Promotion');
      must(r.status === 200, `browse returned ${r.status}`);
      const found = rows(r.html);
      must(found.length === 7, `expected 7 live promotions (8 seeded, 1 expired), got ${found.length}`);
      must(found.some((x) => /SoundHub/.test(x)), 'the merchant is not shown in the list');
      must(found.every((x) => /<td>\d+<\/td>/.test(x)), 'the discount rate is not shown');
      must(found.every((x) => /\d{4}-\d{2}-\d{2}/.test(x)), 'the expiration date is not shown');
      return '7 live promotions, each with its merchant, discount rate and expiry date';
    } },
  { task: "Use the website's search feature to find promotions related to electronics",
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/Promotion?q=electronics');
      const found = rows(r.html);
      must(found.length === 3 && found.every((x) => /SoundHub|ByteMart/.test(x)), `expected the 3 electronics promotions, got ${found.length}: ${found.map((x) => x.slice(0, 40))}`);
      must(!found.some((x) => /FreshCart|Voyago|Northline|HomeNest/.test(x)), 'a non-electronics promotion matched the search');
      return '3 promotions match "electronics" (headphones, laptops, TV bundle); unrelated merchants are excluded';
    } },
  { task: 'Share a new promotion using the provided form with all necessary details filled in',
    run: async ({ post, follow, must, flashOf }) => {
      must((await post('/register', { email: 'newmember@deals.test', password: 'newpass1', name: 'New Member' })).status === 303, 'registration failed');
      const shared = await follow('/Promotion', { title: 'Great new gadget discount', merchant: 'GadgetCo', category: '1',
        description: 'A fine gadget discount for early adopters this week only.', tags: 'gadget', discount: '15', code: 'GADGET15', expiresAt: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) });
      must(/Your promotion is on the board/.test(flashOf(shared.html)), `share was not confirmed: ${flashOf(shared.html)}`);
      must(/<th>Merchant<\/th><td>GadgetCo<\/td>/.test(shared.html) && /<th>Discount<\/th><td>15<\/td>/.test(shared.html) && /<th>Code<\/th><td>GADGET15<\/td>/.test(shared.html),
        `submitted details did not save: ${shared.html.slice(shared.html.indexOf('<table'), shared.html.indexOf('<table') + 400)}`);
      return 'the new promotion is on its own page with every submitted detail';
    } },
  { task: 'Navigate through the main sections (Home, Browse Promotions, Share Promotion, Search) using the website’s navigation menu',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const home = await get('/page/home');
      must(home.status === 200, `home returned ${home.status}`);
      const links = { 'Browse Promotions': '/Promotion', 'Share Promotion': '/Promotion/new', Search: '/Promotion?q=electronics' };
      for (const [label, href] of Object.entries(links)) {
        must(home.html.includes(`href="${href}"`), `home has no "${label}" link to ${href}`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      return 'Home links to Browse Promotions, Share Promotion and Search, and each destination loads';
    } },
  { task: 'Test the user management functionality in the backend by attempting to view and edit user information',
    run: async ({ login, get, post, rows, idOf, must }) => {
      must((await login('admin@deals.test', 'admin123')).status === 303, 'admin could not sign in');
      const users = await get('/User');
      must(users.status === 200 && rows(users.html).length === 4, `admin should see all 4 users, got status ${users.status}`);
      const id = idOf(users.html, 'dana@deals.test', 'User');
      const saved = await post(`/User/${id}`, { email: 'dana@deals.test', name: 'Dana Deals-Fan', role: 'member' });
      must(saved.status === 303, `edit was not accepted: ${saved.status} ${saved.html.slice(0, 200)}`);
      const again = await get(`/User/${id}`);
      must(/<th>Name<\/th><td>Dana Deals-Fan<\/td>/.test(again.html), "the admin's edit did not save");
      return "admin views all 4 users and edits dana@deals.test's name";
    } },
  colorCheck('ivory', 'forestgreen'),
];
