// WebGen-Bench 000092 — skill-sharing directory. One check per ui_instruct case.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify that a user can create a profile and add skills and certifications',
    run: async ({ post, follow, get, must, flashOf }) => {
      const reg = await post('/register', { email: 'jo@skillshare.test', password: 'jo123456', name: 'Jo Ellis', bio: 'Learning to code.' });
      must(reg.status === 303, `registration returned ${reg.status}`);
      const skill = await follow('/Skill', { name: 'Python', level: 'beginner' });
      must(/Skill added to your profile/.test(flashOf(skill.html)), `no confirmation after adding a skill: ${flashOf(skill.html)}`);
      must(/<td>Python<\/td><td>beginner<\/td>/.test(skill.html), 'the added skill is not shown on the profile it landed on');
      const cert = await follow('/Certification', { name: 'CS50', issuer: 'Harvard', year: '2025' });
      must(/Certification added to your profile/.test(flashOf(cert.html)), `no confirmation after adding a certification: ${flashOf(cert.html)}`);
      must(/CS50/.test(cert.html) && /Harvard/.test(cert.html), 'the added certification is not shown on the profile');
      return "Jo's profile shows the Python skill and the CS50 certification she just added";
    } },

  { task: 'Test the search feature by searching for a user based on a specific skill',
    run: async ({ get, rows, must }) => {
      const hit = await get('/Skill?q=Go%20programming');
      const list = rows(hit.html);
      must(list.length === 1 && /Go programming/.test(list[0]) && /wren@skillshare\.test/.test(list[0]),
        `searching for "Go programming" did not return Wren's skill row: ${JSON.stringify(list)}`);
      const none = await get('/Skill?q=Underwater%20basket%20weaving');
      must(rows(none.html).length === 0, 'searching for a skill nobody has returned results');
      return 'searching "Go programming" surfaces Wren Castillo\'s skill row (and, through it, her profile)';
    } },

  { task: "Confirm that a user can view another user's profile, including their skills and certifications",
    run: async ({ get, idOf, must }) => {
      const directory = await get('/User');
      const id = idOf(directory.html, 'Wren Castillo', 'User');
      const profile = await get(`/User/${id}`);
      must(profile.status === 200, `profile page returned ${profile.status}`);
      must(/<th>Name<\/th><td>Wren Castillo<\/td>/.test(profile.html), "Wren's name is not shown on her profile");
      must(/Distributed systems/.test(profile.html) && /Go programming/.test(profile.html) && /Public speaking/.test(profile.html),
        "Wren's skills are not all listed on her profile");
      must(/AWS Certified Solutions Architect/.test(profile.html) && /Amazon Web Services/.test(profile.html) && /2024/.test(profile.html),
        "Wren's certification is not shown on her profile");
      return "Wren's profile lists her 3 skills and her AWS certification in full detail";
    } },

  { task: 'Check the contact functionality by trying to contact another user from their profile page',
    run: async ({ asGuest, login, get, post, idOf, must, flashOf }) => {
      const directory = await get('/User');
      const id = idOf(directory.html, 'Wren Castillo', 'User');
      const profile = await get(`/User/${id}`);
      must(/action\/contact/.test(profile.html), 'no contact option is offered on the profile page');
      const sent = await post(`/User/${id}/action/contact`, { body: 'Hi Wren, could you help me with distributed systems?' });
      must(sent.status === 303, `contacting Wren returned ${sent.status}`);
      const after = await get(sent.location);
      must(/Message sent to Wren Castillo/.test(flashOf(after.html)), `no confirmation after contacting: ${flashOf(after.html)}`);
      asGuest();
      must((await login('wren@skillshare.test', 'wren12345')).status === 303, 'Wren could not sign in to check her messages');
      const inbox = await get('/Message');
      must(/Hi Wren, could you help me with distributed systems\?/.test(inbox.html), "the contact message did not reach Wren's inbox");
      return "the message sent from Jo's profile visit reaches Wren's private inbox";
    } },

  navCheck(3),

  colorCheck('cornsilk', 'peru'),
];
