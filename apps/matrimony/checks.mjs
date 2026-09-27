// WebGen-Bench 000091 — matrimonial matchmaking site. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Test the user registration form for creating a new account',
    run: async ({ post, must }) => {
      const bad = await post('/register', { email: 'not-an-adult@matrimony.test', password: 'secret12', name: 'Too Young', age: '16' });
      must(bad.status === 400 && /at least 18/.test(bad.html), 'an under-18 registration was accepted');
      const ok = await post('/register', { email: 'mia@matrimony.test', password: 'mia123456', name: 'Mia', age: '26', gender: 'female',
        location: 'Boston', interests: 'reading, travel', bio: 'Loves long walks.' });
      must(ok.status === 303, `valid registration returned ${ok.status}: ${ok.html.slice(0, 200)}`);
      const dup = await post('/register', { email: 'mia@matrimony.test', password: 'other1234', name: 'Dup', age: '30' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate registration was accepted');
      return 'valid registration succeeds; an under-18 or duplicate registration is rejected with a clear error';
    } },

  { task: 'Verify the login functionality with valid credentials',
    run: async ({ asGuest, login, get, must, flashOf }) => {
      asGuest();
      const r = await login('mia@matrimony.test', 'mia123456');
      must(r.status === 303, `login returned ${r.status}`);
      const home = await get(r.location);
      must(/Welcome, mia@matrimony.test/.test(flashOf(home.html)), 'no welcome confirmation after login');
      must(/Leah Kim/.test(home.html) && /Omar Siddiqui/.test(home.html), 'the signed-in member does not land on the member directory');
      return 'Mia signed in and was redirected to the member directory (her dashboard)';
    } },

  { task: 'Check the advanced search feature for looking up potential partners based on specific criteria (e.g., age, location, interests)',
    run: async ({ get, rows, must }) => {
      const byGenderAndAge = await get('/User?gender=female&age_from=25&age_to=30');
      const list = rows(byGenderAndAge.html);
      must(list.every((r) => /<td>female<\/td>/.test(r)) && list.some((r) => r.includes('Priya Menon')) && list.some((r) => r.includes('Leah Kim')),
        `expected Leah and Priya among the female, 25-30 results, got: ${JSON.stringify(list)}`);
      const byAgeOnly = await get('/User?age_from=32&age_to=32');
      must(rows(byAgeOnly.html).length === 1 && rows(byAgeOnly.html)[0].includes('Omar'), 'an exact age filter did not narrow to Omar (32)');
      const byLocation = await get('/User?q=Seattle');
      must(rows(byLocation.html).length === 2, 'a location search for Seattle did not narrow to the two Seattle members');
      const byInterest = await get('/User?q=chess');
      const chess = rows(byInterest.html);
      must(chess.length === 1 && chess[0].includes('Omar'), 'an interest search for "chess" did not find Omar');
      return 'age+gender filter finds Leah and Priya; location search finds the two Seattle members; interest search finds Omar';
    } },

  { task: 'Validate the chat functionality by initiating a private chat between two users',
    run: async ({ asGuest, login, get, post, idOf, must, flashOf }) => {
      const directory = await get('/User');
      const leahId = idOf(directory.html, 'Leah Kim', 'User');
      const miaId = idOf(directory.html, 'Mia', 'User');
      const sent = await post(`/User/${leahId}/action/contact`, { body: 'Hi Leah, I loved your profile!' });
      must(sent.status === 303, `sending a message returned ${sent.status}`);
      const sentPage = await get(sent.location);
      must(/Message sent to Leah Kim/.test(flashOf(sentPage.html)), `no confirmation after messaging: ${flashOf(sentPage.html)}`);
      asGuest();
      must((await login('leah@matrimony.test', 'leah12345')).status === 303, 'Leah could not sign in to read her messages');
      const inbox = await get('/Message');
      must(/Hi Leah, I loved your profile!/.test(inbox.html), 'the message did not reach Leah\'s private inbox');
      const reply = await post(`/User/${miaId}/action/contact`, { body: 'Thanks Mia! Would love to chat more.' });
      must(reply.status === 303, `Leah's reply returned ${reply.status}`);
      asGuest();
      must((await login('omar@matrimony.test', 'omar12345')).status === 303, 'Omar could not sign in');
      const omarInbox = await get('/Message');
      must(!/Hi Leah, I loved your profile!/.test(omarInbox.html) && !/Would love to chat more/.test(omarInbox.html),
        'a third member can read messages that are not addressed to him — the chat is not private');
      asGuest();
      must((await login('mia@matrimony.test', 'mia123456')).status === 303, 'Mia could not sign back in');
      const miaInbox = await get('/Message');
      must(/Thanks Mia! Would love to chat more\./.test(miaInbox.html), 'Leah\'s reply did not reach Mia\'s inbox');
      return 'private messages exchanged between Mia and Leah; a third member (Omar) sees neither';
    } },

  { task: 'Test the logout process to ensure users can safely exit their accounts',
    run: async ({ post, get, must, flashOf }) => {
      const out = await post('/logout', {});
      must(out.status === 303, `logout returned ${out.status}`);
      must(/ok=Signed(%20|\+)out/.test(out.location), `no sign-out confirmation in the redirect: ${out.location}`);
      const protectedPage = await get('/Message');
      must(protectedPage.location.startsWith('/login'), 'after logout, a protected page is still reachable without signing in again');
      return 'logged out; the session is cleared and the member directory now requires signing in again';
    } },

  { task: 'Verify that error messages and prompts provide clear, user-friendly instructions when users perform invalid login actions (e.g., incorrect password)',
    run: async ({ login, must }) => {
      const wrongPassword = await login('mia@matrimony.test', 'not-the-password');
      must(wrongPassword.status === 401 && /Wrong login or password/.test(wrongPassword.html), `unclear or missing error for a wrong password: ${wrongPassword.status}`);
      const unknownEmail = await login('nobody@matrimony.test', 'whatever123');
      must(unknownEmail.status === 401 && /Wrong login or password/.test(unknownEmail.html), 'an unknown email does not get the same clear error');
      return 'a wrong password and an unknown email both get the same clear, non-technical "Wrong login or password" message';
    } },

  colorCheck('lemonchiffon', 'chocolate'),
];
