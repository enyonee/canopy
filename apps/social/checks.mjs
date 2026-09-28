// WebGen-Bench 000090 — social platform. One check per ui_instruct case.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let annId = null;

export const checks = [
  { task: "Attempt to register a new user with valid details using the registration form",
    run: async ({ post, must }) => {
      const r = await post('/register', { email: 'ann@social-platform.test', password: 'secret1', name: 'Ann' });
      must(r.status === 303, `registration returned ${r.status}: ${r.html.slice(0, 200)}`);
      return 'Ann registered successfully';
    } },

  { task: "Log in with the newly registered user's credentials",
    run: async ({ asGuest, login, get, must, flashOf }) => {
      asGuest();
      const r = await login('ann@social-platform.test', 'secret1');
      must(r.status === 303, `login returned ${r.status}`);
      const home = await get(r.location);
      must(/Welcome, ann@social-platform.test/.test(flashOf(home.html)), `no welcome flash after login: ${flashOf(home.html)}`);
      must(/My profile/.test(home.html) && /<td>Ann<\/td>/.test(home.html), `the home page does not welcome Ann by name: ${home.html.slice(0, 400)}`);
      return "Ann is redirected to her own profile row, which shows her name: 'Ann'";
    } },

  { task: 'Navigate to the user profile section and verify the display of user information, including profile picture, name, and any recent updates',
    run: async ({ get, idOf, must }) => {
      const me = await get('/list/me');
      annId = idOf(me.html, 'Ann', 'User');
      const profile = await get(`/User/${annId}`);
      must(profile.status === 200, `profile page returned ${profile.status}`);
      must(/<th>Name<\/th><td>Ann<\/td>/.test(profile.html) && /<th>Email<\/th><td>ann@social-platform\.test<\/td>/.test(profile.html),
        'name and email are not shown on the profile page');
      must(/My uploads/.test(profile.html), 'the profile page has no section for the user\'s own updates (photos)');
      return "Ann's profile page shows her name, email and a My uploads section for her updates";
    } },

  { task: 'Invite a friend to join the website by sending an invitation via a provided function',
    run: async ({ follow, get, must, flashOf }) => {
      const sent = await follow('/Invitation', { email: 'friend@example.test' });
      must(/Invitation sent!/.test(flashOf(sent.html)), `no confirmation after inviting: ${flashOf(sent.html)}`);
      return 'invitation to friend@example.test confirmed and queued as an outgoing letter';
    } },

  { task: 'Upload a picture as the logged-in user and check for successful upload indication',
    run: async ({ upload, get, must, flashOf, rowWith }) => {
      const posted = await upload('/Photo', { caption: 'Sunset over the bay' }, { field: 'image', name: 'sunset.png', content: 'not-a-real-png-but-a-file' });
      must(posted.status === 303, `photo upload returned ${posted.status}: ${posted.html.slice(0, 200)}`);
      const after = await get(posted.location);
      must(/Photo uploaded/.test(flashOf(after.html)), `no confirmation after uploading: ${flashOf(after.html)}`);
      const gallery = await get('/Photo');
      must(rowWith(gallery.html, 'Sunset over the bay'), 'the uploaded photo is not in the gallery');
      const profile = await get(`/User/${annId}`);
      must(rowWith(profile.html, 'Sunset over the bay'), "the uploaded photo does not appear under the user's own My uploads");
      return 'photo uploaded, confirmed, and shown in both the gallery and the uploader\'s own profile';
    } },

  { task: 'Vote on a piece of content (e.g., picture) on the website',
    run: async ({ asGuest, login, get, follow, idOf, must, flashOf }) => {
      asGuest();
      must((await login('admin@social-platform.test', 'admin123')).status === 303, 'admin could not sign in to vote');
      const gallery = await get('/Photo');
      const photoId = idOf(gallery.html, 'Sunset over the bay', 'Photo');
      const before = await get(`/Photo/${photoId}`);
      must(/<th>Votes<\/th><td>0<\/td>/.test(before.html), `expected 0 votes before voting: ${before.html}`);
      const voted = await follow(`/Photo/${photoId}/action/votePhoto`, {});
      must(/Thanks for your vote/.test(flashOf(voted.html)), `no confirmation after voting: ${flashOf(voted.html)}`);
      const after = await get(`/Photo/${photoId}`);
      must(/<th>Votes<\/th><td>1<\/td>/.test(after.html), 'the vote count did not update to 1');
      // Round 4: votePhoto uses db.ensure, not db.createRow, so a repeat vote by the same
      // member is idempotent — it must not inflate the count a second time. Round 6:
      // rules.Vote now also declares {"unique": ["photo", "voter"]} as a backstop — the
      // guard runs inside the store itself (Store#insert/#update), covering db.ensure too,
      // not only an HTTP form, so this stays true even if votePhoto's step ever changes.
      await follow(`/Photo/${photoId}/action/votePhoto`, {});
      const again = await get(`/Photo/${photoId}`);
      must(/<th>Votes<\/th><td>1<\/td>/.test(again.html), `voting twice inflated the count: ${again.html.match(/<th>Votes<\/th><td>\d+<\/td>/)}`);
      return 'vote registered; the photo\'s vote total updated from 0 to 1, and stayed at 1 on a repeat vote';
    } },

  { task: 'Check the user points system by performing an action that earns points (e.g., logging in, uploading content) and verifying the points update',
    run: async ({ asGuest, login, get, must } ) => {
      asGuest();
      must((await login('ann@social-platform.test', 'secret1')).status === 303, 'Ann could not sign back in');
      const before = await get('/list/me');
      must(/<td>10<\/td>/.test(before.html), `Ann's points did not reflect her one upload (expected 10): ${before.html}`);
      return "Ann's points tally is 10 after her one upload (10 points per upload, a derived aggregate — not a login-triggered counter, see NOTES)";
    } },

  navCheck(3),

  colorCheck('lightcyan', 'cadetblue'),
];
