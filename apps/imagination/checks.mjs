// WebGen-Bench 000093 — World of Imagination. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Browse the creative works section',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/CreativeWork');
      must(r.status === 200, `creative works section returned ${r.status}`);
      const list = rows(r.html);
      must(list.length === 2, `expected 2 seeded creative works, got ${list.length}`);
      must(/A city grown from coral/.test(r.html) && /Concept sketches for a coastal city/.test(r.html), 'a creative work title/description is missing');
      must(/Songs for a second moon/.test(r.html), 'the second creative work is missing');
      return '2 creative works listed with image, title, description and author';
    } },

  { task: 'Submit a new idea via the share ideas form',
    run: async ({ post, follow, must, flashOf, rowWith }) => {
      must((await post('/register', { email: 'milo@imagination.test', password: 'milo12345', name: 'Milo' })).status === 303, 'registration for the idea test failed');
      const shared = await follow('/Idea', { title: 'Dreams as shared playlists', body: 'What if dreams could be recorded and shared like songs?' });
      must(/Your idea has been shared/.test(flashOf(shared.html)), `no confirmation after sharing an idea: ${flashOf(shared.html)}`);
      const row = rowWith(shared.html, 'Dreams as shared playlists');
      must(row && /What if dreams could be recorded/.test(row) && /milo@imagination\.test/.test(row), `the new idea is not in the shared ideas section: ${row}`);
      return 'Milo\'s idea appears in the Share Ideas section right after submitting, with a confirmation message';
    } },

  { task: 'Participate in a discussion by posting a comment',
    run: async ({ get, follow, must, flashOf } ) => {
      const posted = await follow('/Discussion/1/add/Comment', { body: 'A door that only opens to the question you needed to ask.' });
      must(/Comment posted/.test(flashOf(posted.html)), `no confirmation after commenting: ${flashOf(posted.html)}`);
      must(/A door that only opens to the question you needed to ask\./.test(posted.html), 'the comment body is not shown under the discussion');
      const row = new RegExp(`<tr><td><a href="/User/\\d+">milo@imagination\\.test</a></td><td>A door that only opens to the question you needed to ask\\.</td><td>(20\\d\\d-[^<]+)</td></tr>`).exec(posted.html);
      must(row, `comment row with correct author and timestamp not found: ${posted.html.slice(posted.html.indexOf('Comments'))}`);
      return 'comment visible under the discussion with the correct username (milo@imagination.test) and a timestamp';
    } },

  { task: 'Navigate through the main pages (Home, Creative Works, Share Ideas, Discussions, Interactions) using the website\'s navigation menu',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.status === 200 && /World of Imagination/.test(home.html), 'the Home page does not load');
      for (const [path, marker] of [['/CreativeWork', 'Creative Works'], ['/Idea', 'Share Ideas'], ['/Discussion', 'Discussions'], ['/User', 'Interactions']]) {
        const r = await get(path);
        must(r.status === 200 && new RegExp(marker).test(r.html), `${path} (${marker}) did not load correctly: ${r.status}`);
      }
      return 'Home, Creative Works, Share Ideas, Discussions and Interactions all load without errors';
    } },

  { task: 'Interact with another user by sending a message',
    run: async ({ asGuest, login, get, post, idOf, rowWith, must, flashOf } ) => {
      const directory = await get('/User');
      const noraId = idOf(directory.html, 'nora@imagination.test', 'User');
      const before = rowWith(directory.html, 'nora@imagination.test');
      must(/<td>Nora Vance<\/td><td>nora@imagination\.test<\/td><td>0<\/td>/.test(before), `expected Nora to start with 0 unread messages: ${before}`);
      const sent = await post(`/User/${noraId}/action/contact`, { body: 'Loved your concept album!' });
      must(sent.status === 303, `sending the message returned ${sent.status}`);
      const after = await get(sent.location);
      must(/Message sent to Nora Vance/.test(flashOf(after.html)), `no delivery confirmation: ${flashOf(after.html)}`);
      asGuest();
      must((await login('nora@imagination.test', 'nora12345')).status === 303, 'Nora could not sign in to check her notification');
      const inbox = await get('/Message');
      must(/Loved your concept album!/.test(inbox.html) && />New</.test(inbox.html), 'the message did not reach Nora\'s inbox as unread');
      const directoryAsNora = await get('/User');
      const ownRow = rowWith(directoryAsNora.html, 'nora@imagination.test');
      must(/<td>Nora Vance<\/td><td>nora@imagination\.test<\/td><td>1<\/td>/.test(ownRow), `Nora's unread notification did not increase to 1: ${ownRow}`);
      return "Milo's message reached Nora's private inbox with her unread notification counter going 0 → 1";
    } },

  colorCheck('azure', 'darkslateblue'),
];
