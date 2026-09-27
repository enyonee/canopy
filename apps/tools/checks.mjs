// webgen-bench/000077 — tool information site: one check per ui_instruct case, in order.
import { colorCheck } from '../../verify/lib.mjs';

let drillId = null, powerToolsId = null;

export const checks = [
  { task: 'Test the user registration form by creating a new account',
    run: async ({ asGuest, get, post, must, flashOf }) => {
      asGuest();
      const form = await get('/register');
      must(form.status === 200 && /name="email"/.test(form.html) && /name="password"/.test(form.html) && /name="name"/.test(form.html), 'the registration form is missing fields');
      const r = await post('/register', { email: 'nina@tools.test', password: 'nina123', name: 'Nina Newton' });
      must(r.status === 303, `register returned ${r.status}: ${r.html.slice(0, 200)}`);
      const home = await get(r.location);
      must(/Welcome, nina@tools.test/.test(flashOf(home.html)), `no confirmation message: ${flashOf(home.html)}`);
      must(/Signed in as nina@tools.test \(member\)/.test(home.html), 'the new account is not signed in');
      must(/<h2>Tools<\/h2>/.test(home.html) && /Cordless drill/.test(home.html), 'the new user did not land on the tools dashboard');
      const dup = await post('/register', { email: 'nina@tools.test', password: 'x', name: 'Nina again' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate email was accepted');
      return 'account created, welcome flash, signed in as member on the tools page, duplicate refused';
    } },
  { task: 'Perform a login operation using valid credentials',
    run: async ({ asGuest, login, get, must, flashOf }) => {
      asGuest();
      const bad = await login('eve@tools.test', 'wrong');
      must(bad.status === 401 && /Wrong login or password/.test(bad.html), 'a wrong password was accepted');
      const r = await login('eve@tools.test', 'eve123');
      must(r.status === 303, `login returned ${r.status}`);
      const home = await get(r.location);
      must(/Signed in as eve@tools.test \(member\)/.test(home.html), 'the header does not confirm the account');
      must(/Welcome, eve@tools.test/.test(flashOf(home.html)), 'no welcome flash after login');
      must(/Cordless drill/.test(home.html) && /Torque wrench/.test(home.html), 'the dashboard does not list the tools');
      return 'wrong password 401; valid login lands on the tools page signed in as member';
    } },
  { task: 'Search for a specific tool using the search functionality',
    run: async ({ get, rows, rowWith, must }) => {
      const all = await get('/Tool');
      must(rows(all.html).length === 4, `expected 4 tools, got ${rows(all.html).length}`);
      const s = await get('/Tool?q=drill');
      must(rows(s.html).length === 1 && rowWith(s.html, 'Cordless drill'), `search by name returned ${rows(s.html).length} row(s)`);
      const row = rowWith(s.html, 'Cordless drill');
      must(/Power tools/.test(row) && /Drilling and driving screws/.test(row) && /129\.90/.test(row), `basic details are missing from the result: ${row}`);
      const byFunction = await get('/Tool?q=torque');
      must(rows(byFunction.html).length === 1 && rowWith(byFunction.html, 'Torque wrench'), 'search does not match the function text');
      const none = await get('/Tool?q=zzzz');
      must(rows(none.html).length === 0, 'an unmatched query still lists tools');
      return '"drill" → 1 row with category, function and price; "torque" → 1; no match → 0';
    } },
  { task: 'Apply a filter to the tools section based on tool category',
    run: async ({ get, rows, rowWith, must }) => {
      const tools = await get('/Tool');
      const link = /<a class="btn" href="\/Tool\?category=(\d+)">Power tools<\/a>/.exec(tools.html);
      must(link, 'no category filter with a "Power tools" option on the tools list');
      powerToolsId = link[1];
      const f = await get(`/Tool?category=${powerToolsId}`);
      must(new RegExp(`href="/Tool\\?category=${powerToolsId}" aria-current="true">Power tools`).test(f.html), 'the chosen category is not marked active');
      must(rows(f.html).length === 2, `expected 2 power tools, got ${rows(f.html).length}`);
      must(rowWith(f.html, 'Cordless drill') && rowWith(f.html, 'Angle grinder'), 'power tools are missing');
      must(!rowWith(f.html, 'Torque wrench') && !rowWith(f.html, 'Digital caliper'), 'other categories are not excluded');
      return 'Power tools → drill and grinder only';
    } },
  { task: 'View detailed information for a specific tool by clicking on it',
    run: async ({ get, idOf, must }) => {
      const list = await get('/Tool');
      drillId = idOf(list.html, 'Cordless drill', 'Tool');
      must(new RegExp(`href="/Tool/${drillId}"`).test(list.html), 'the tool row has no link to its page');
      const d = await get(`/Tool/${drillId}`);
      must(d.status === 200, `detail returned ${d.status}`);
      must(/<h2>Cordless drill<\/h2>/.test(d.html), 'the tool name is not the page title');
      must(/<th>Description<\/th><td>18 V brushless drill driver with two batteries\.<\/td>/.test(d.html), 'description is missing');
      must(/<th>Function<\/th><td>Drilling and driving screws<\/td>/.test(d.html), 'function is missing');
      must(/<th>Price<\/th><td>129\.90<\/td>/.test(d.html), 'price is missing');
      must(/<th>Brand<\/th><td>Makita<\/td>/.test(d.html) && /<th>Rating<\/th><td>5<\/td>/.test(d.html), 'brand or derived rating missing');
      must(/Plenty of torque/.test(d.html), 'the existing review is not shown under the tool');
      return 'name, description, function, price, brand, rating and the seeded review';
    } },
  { task: 'Add a comment and rating to a tool as a logged-in user',
    run: async ({ asGuest, login, get, post, follow, rowWith, must, flashOf }) => {
      asGuest();
      const anon = await post(`/Tool/${drillId}/add/Review`, { rating: 3, comment: 'anonymous' });
      must(anon.status === 403, `a guest could post a review: ${anon.status}`);
      await login('nina@tools.test', 'nina123');
      const bad = await post(`/Tool/${drillId}/add/Review`, { rating: 7, comment: 'Too good' });
      must(bad.status === 400 && /Rating must be between 1 and 5/.test(bad.html), 'a rating of 7 was accepted');
      const r = await follow(`/Tool/${drillId}/add/Review`, { rating: 3, comment: 'Chuck wobbles a little at high speed' });
      must(/Thanks, your review is posted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Chuck wobbles a little');
      must(row && /nina@tools.test/.test(row) && /<td>3<\/td>/.test(row), `the review row is wrong: ${row}`);
      must(/<th>Reviews<\/th><td>2<\/td>/.test(r.html) && /<th>Rating<\/th><td>4<\/td>/.test(r.html), 'the derived count and average rating did not follow (5 and 3 → 4)');
      const reviews = await get('/Review');
      must(rowWith(reviews.html, 'Chuck wobbles a little'), 'the review is not in the reviews list');
      must(!/\/delete"/.test(r.html), 'a member is offered to delete reviews');
      return 'guest → login; rating 7 refused; review posted under the tool with author, count 2, rating 4';
    } },
  colorCheck('ivory', 'forestgreen'),
];

export const changes = [
  { title: 'second role with reduced access', patch: 'change-1-role.patch.json', checks: [
    { task: 'The admin creates an editor; the editor adds and edits tools but deletes nothing, cannot manage users and sees no outbox',
      run: async ({ asGuest, login, post, get, follow, rows, rowWith, must, flashOf }) => {
        asGuest();
        await login('admin@tools.test', 'admin123');
        const made = await post('/User', { email: 'ed@tools.test', password: 'ed123', name: 'Ed Editor', role: 'editor' });
        must(made.status === 303, `creating the editor returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        must((await login('ed@tools.test', 'ed123')).status === 303, 'the editor could not log in');
        const tools = await get('/Tool');
        must(rows(tools.html).length === 4 && rowWith(tools.html, 'Cordless drill'), 'the editor does not see the catalogue');
        must(/href="\/Tool\/new"/.test(tools.html) && !/\/delete"/.test(tools.html), 'the editor should be offered to add, not to delete');
        const added = await follow('/Tool', { name: 'Laser level', category: 3, description: 'Cross-line laser, 15 m range.', function: 'Levelling and alignment', price: '89', brand: 'Bosch' });
        must(/Tool saved/.test(flashOf(added.html)) && /<h2>Laser level<\/h2>/.test(added.html), 'the editor could not add a tool');
        const edited = await post(`/Tool/${drillId}`, { price: '119.9' });
        must(edited.status === 303, `the editor could not edit a tool: ${edited.status}`);
        must(/<th>Price<\/th><td>119\.90<\/td>/.test((await get(`/Tool/${drillId}`)).html), 'the edit did not stick');
        must((await post(`/Tool/${drillId}/delete`, {})).status === 403, 'the editor deleted a tool');
        must((await get('/Tool')).html.includes('Cordless drill'), 'the drill is gone');
        const detail = await get(`/Tool/${drillId}`);
        must(/Chuck wobbles a little/.test(detail.html) && /Plenty of torque/.test(detail.html), `the reviews written before the change are gone: ${detail.html.slice(-1500)}`);
        must(/\/Review\/\d+\/delete"/.test(detail.html), 'the editor is not offered to moderate reviews');
        must((await get('/User/new')).status === 403 && (await post('/User', { email: 'x@tools.test', password: 'x', name: 'X', role: 'admin' })).status === 403, 'the editor managed users');
        must((await get('/outbox')).status === 403, 'the editor opened the outbox');
        return 'editor: sees 4 tools + adds one, edits price, delete 403, users 403, outbox 403, moderates reviews';
      } },
  ] },
];
