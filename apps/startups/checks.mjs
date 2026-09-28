// WebGen-Bench 000089 — startup story publishing site. One check per ui_instruct case.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify Article Browsing (browse under different categories)',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const funding = await get('/Article?category=funding');
      must(funding.status === 200, `category browse returned ${funding.status}`);
      const list = rows(funding.html);
      must(list.length === 2 && list.every((r) => /<td>funding<\/td>/.test(r)), `expected 2 funding articles, got ${list.length}`);
      const all = rows((await get('/Article')).html);
      must(all.length === 6, `expected all 6 articles unfiltered, got ${all.length}`);
      return '2 funding articles when filtered by category; 6 total unfiltered';
    } },

  { task: 'Test Search Functionality',
    run: async ({ get, rows, must }) => {
      const hit = await get('/Article?q=bridge');
      const list = rows(hit.html);
      must(list.length === 1 && /Raising a bridge round/.test(list[0]), `search for "bridge" did not return the matching article: ${list.length}`);
      const none = await get('/Article?q=zzzznotfound');
      must(rows(none.html).length === 0, 'search returned results for a query matching nothing');
      return 'search for "bridge" narrows to the one matching article; a nonsense query returns none';
    } },

  { task: 'Check Article Collection Feature',
    run: async ({ post, get, idOf, rows, must, flashOf }) => {
      must((await post('/register', { email: 'lee@startups.test', password: 'lee12345', name: 'Lee Park' })).status === 303, 'registration for the collection test failed');
      const list = await get('/Article');
      const id = idOf(list.html, 'From 10 to 10,000 users', 'Article');
      const collected = await get(`/Article/${id}`);
      must(/action\/collect/.test(collected.html), 'no Collect button on the article');
      const posted = await post(`/Article/${id}/action/collect`, {});
      must(posted.status === 303, `collecting returned ${posted.status}`);
      const after = await get(posted.location);
      must(/added to your collection/.test(flashOf(after.html)), `no confirmation after collecting: ${flashOf(after.html)}`);
      const mine = rows(after.html);
      must(mine.length === 1 && /From 10 to 10,000 users/.test(mine[0]), `the collected article is not in "My collections": ${JSON.stringify(mine)}`);
      // Round 6: rules.Collection now declares {"unique": ["user", "article"]} as a
      // backstop — db.ensure already kept a repeat collect a no-op, and stays the
      // reason it succeeds again (303) rather than being refused; the rule now
      // also means any future write path to Collection cannot silently duplicate.
      const again = await post(`/Article/${id}/action/collect`, {});
      must(again.status === 303, `collecting the same article twice was refused instead of staying idempotent: ${again.status}`);
      const stillMine = rows((await get(again.location)).html);
      must(stillMine.length === 1, `collecting twice duplicated the collection row: ${JSON.stringify(stillMine)}`);
      return 'the collected article is added and shown in the dedicated My collections section, and stays a single row when collected again';
    } },

  { task: 'Validate Article Sharing Capability',
    run: async ({ asGuest, get, follow, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Article');
      const id = idOf(list.html, 'Why we rebuilt our product', 'Article');
      must(/action\/share/.test(list.html), 'no Share button offered on the article listing');
      const shared = await follow(`/Article/${id}/action/share`, {});
      must(new RegExp(`Link ready to share: /Article/${id}`).test(flashOf(shared.html)), `sharing did not confirm a transmittable link: ${flashOf(shared.html)}`);
      return `sharing article #${id} confirms a permalink (a real client-side share sheet is outside a server-rendered scaffold; recorded as a Miss)`;
    } },

  { task: 'Assess User Registration Process',
    run: async ({ post, must }) => {
      const ok = await post('/register', { email: 'nadia@startups.test', password: 'nadia123', name: 'Nadia Costa' });
      must(ok.status === 303, `registration returned ${ok.status}`);
      const dup = await post('/register', { email: 'nadia@startups.test', password: 'other12345', name: 'Dup' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate registration was accepted without an error');
      return 'Nadia registered; a duplicate email is rejected with a clear error';
    } },

  { task: 'Test User Login Functionality',
    run: async ({ asGuest, login, get, must, flashOf }) => {
      asGuest();
      const r = await login('nadia@startups.test', 'nadia123');
      must(r.status === 303, `login returned ${r.status}`);
      const home = await get(r.location);
      must(/Welcome, nadia@startups.test/.test(flashOf(home.html)), 'no welcome confirmation after login');
      must(/My collections/.test(home.html) || /my-collections/.test(home.html), 'signed-in member cannot reach their collections from the home page nav');
      return 'Nadia signed in and lands on a personalised home page with access to her collections';
    } },

  { task: 'Validate Reading History Tracking',
    run: async ({ get, post, idOf, must, flashOf, rows }) => {
      const list = await get('/Article');
      const id = idOf(list.html, 'Remote-first culture', 'Article');
      const marked = await post(`/Article/${id}/action/markRead`, {});
      must(marked.status === 303, `marking as read returned ${marked.status}`);
      const after = await get(marked.location);
      must(/Marked as read/.test(flashOf(after.html)), `no confirmation after marking read: ${flashOf(after.html)}`);
      const history = await get('/list/my-history');
      const entries = rows(history.html);
      must(entries.length === 1 && /Remote-first culture/.test(entries[0]), `reading history does not list the article: ${JSON.stringify(entries)}`);
      const again = await post(`/Article/${id}/action/markRead`, {});
      must(again.status === 303, 're-reading the same article should stay idempotent, not error');
      must(rows((await get('/list/my-history')).html).length === 1, 're-reading the same article duplicated the history entry');
      return 'reading history records the article once (idempotent on repeat reads via the explicit Mark as read action; see NOTES for why it is not a passive view hook)';
    } },

  navCheck(3),

  colorCheck('oldlace', 'rosybrown'),
];
