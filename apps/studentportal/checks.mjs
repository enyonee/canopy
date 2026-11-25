// webgen-bench/000057 — student portal: registration, profile, matching, applying,
// provider access and direct communication.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let profileId = null, matchId = null;

// A JSON read as a signed-in user, on a session of its own (the check's cookie jar answers HTML).
// With `form`, the same session posts it (a JSON write answers with the row it stored).
const jsonAs = async (base, login, password, p, form = null) => {
  const signIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login, password }).toString() });
  const cookie = (signIn.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(base + p, form
    ? { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }
    : { headers: { cookie, accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
};

export const checks = [
  { task: 'Test the student registration functionality',
    run: async ({ post, follow, get, rows, must, flashOf }) => {
      const reg = await post('/register', { email: 'maria@portal.test', password: 'maria123', name: 'Maria Gomez' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const created = await follow('/StudentProfile', { name: 'Maria Gomez', location: 'Springfield',
        fieldOfStudy: 'data-science', careerInterest: 'industry', qualification: 'bachelor',
        qualificationDetails: 'BSc Data Science, Riverside University', bio: 'Aspiring data analyst.' });
      must(/Profile created — you are now visible to matching providers/.test(flashOf(created.html)), `flash: ${flashOf(created.html)}`);
      const mine = rows(created.html);
      must(mine.length === 1, `expected exactly one profile row, got ${mine.length}`);
      must(/Maria Gomez/.test(mine[0]) && /Springfield/.test(mine[0]) && /data-science/.test(mine[0])
        && /industry/.test(mine[0]) && /bachelor/.test(mine[0]), `profile row missing stored details: ${mine[0]}`);
      profileId = /\/StudentProfile\/(\d+)/.exec(mine[0])[1];
      return `registered and profile #${profileId} created with personal details, qualifications and career preference`;
    } },
  { task: 'Verify the profile management feature by updating personal details in the student profile',
    run: async ({ get, follow, must, flashOf }) => {
      const before = await get(`/StudentProfile/${profileId}/edit`);
      must(before.status === 200 && /value="Springfield"/.test(before.html), 'the edit form does not preload the current details');
      const r = await follow(`/StudentProfile/${profileId}`, { name: 'Maria Gomez', location: 'Rivertown',
        fieldOfStudy: 'data-science', careerInterest: 'industry', qualification: 'bachelor',
        qualificationDetails: 'BSc Data Science, Riverside University', bio: 'Relocated; still job-hunting in data.' });
      must(/Profile updated/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const detail = await get(`/StudentProfile/${profileId}`);
      must(/<th>Location<\/th><td>Rivertown<\/td>/.test(detail.html), `reopening the profile does not show the update: ${detail.html}`);
      return 'location changed to Rivertown, saved and reflected when reopening the profile';
    } },
  { task: 'Check the advanced matching algorithm by inputting student qualifications, location, field of study, and career interests',
    run: async ({ get, rowWith, must }) => {
      const list = await get('/Match');
      must(list.status === 200, `matches list returned ${list.status}`);
      const tech = rowWith(list.html, 'TechForward Institute');
      const health = rowWith(list.html, 'HealthBridge College');
      must(tech && /<td>70<\/td>/.test(tech) && />Match<\/td>/.test(tech),
        `TechForward should match at 70 (same field, interest and qualification): ${tech}`);
      must(health && /<td>30<\/td>/.test(health) && />Not a match<\/td>/.test(health),
        `HealthBridge should not match at 30 (same city only): ${health}`);
      return 'moving to Rivertown: TechForward stays a match (70, field+interest+qualification), HealthBridge is not (30, city only)';
    } },
  { task: 'Validate the application process by applying for a program through the portal',
    run: async ({ get, follow, rows, rowWith, must, flashOf }) => {
      const r = await follow('/Provider/1/action/apply', { message: "I'm very interested in your data-science bootcamp." });
      must(/Application submitted to TechForward Institute — you will hear back soon/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.length === 1 && /TechForward Institute/.test(mine[0]) && /interested in your data-science bootcamp/.test(mine[0]),
        `application not recorded: ${mine.map((x) => x.slice(0, 160))}`);
      return 'application to TechForward Institute submitted with a confirmation, and listed under Applications';
    } },
  { task: "Test the training provider's access by attempting to view student information based on predefined criteria",
    run: async ({ asGuest, login, get, follow, rows, rowWith, idOf, must, flashOf }) => {
      asGuest();
      must((await login('tech@portal.test', 'tech123')).status === 303, 'the provider could not log in');
      const list = await get('/Match');
      must(list.status === 200, `provider matches list returned ${list.status}`);
      const found = rows(list.html);
      must(found.length === 2, `expected 2 matching students (Alice and Maria), got ${found.length}`);
      must(rowWith(list.html, 'Alice Kim') && rowWith(list.html, 'Maria Gomez'), `both matching students should be listed: ${found.map((r) => r.slice(0, 140))}`);
      matchId = idOf(list.html, 'Maria Gomez', 'Match');
      const detail = await get(`/Match/${matchId}`);
      must(/name="body"/.test(detail.html), 'no way to message the matching student from the match page');
      const sent = await follow(`/Match/${matchId}/add/Message`, { body: "Hi Maria, we'd love to have you tour our campus!" });
      must(/Message sent/.test(flashOf(sent.html)), `flash: ${flashOf(sent.html)}`);
      must(/love to have you tour our campus/.test(sent.html) && /tech@portal\.test/.test(sent.html), 'the sent message is not shown under the match');
      return 'provider sees both matching students (Alice, Maria) and messages Maria directly from the match page';
    } },
  { task: "Inspect the website's navigation functionality",
    run: async (ctx) => navCheck(3).run(ctx) },
  { task: 'Review the direct communication feature between training providers and students',
    run: async ({ base, asGuest, login, get, post, follow, must, flashOf }) => {
      asGuest();
      must((await login('maria@portal.test', 'maria123')).status === 303, 'maria could not sign back in');
      const detail = await get(`/Match/${matchId}`);
      must(/love to have you tour our campus/.test(detail.html) && /tech@portal\.test/.test(detail.html),
        "Maria cannot see the provider's message");
      const r = await follow(`/Match/${matchId}/add/Message`, { body: "Thank you! I'd love to visit next week." });
      must(/Message sent/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/love to visit next week/.test(r.html) && /maria@portal\.test/.test(r.html), 'the reply is not shown under the match');
      must((r.html.match(/<h3>Messages<\/h3>/g) || []).length === 1, 'the messages section should list both sides of the conversation once');
      // The conversation is Maria's and TechForward's only: another student and another provider read none of it.
      const thread = await jsonAs(base, 'maria@portal.test', 'maria123', '/Message');
      must(thread.status === 200 && thread.body.total === 2, `Maria's thread has ${thread.body.total} message(s), expected 2`);
      const ids = thread.body.rows.map((m) => m.id);
      for (const [who, password] of [['alice@portal.test', 'alice123'], ['health@portal.test', 'health123']]) {
        const listed = await jsonAs(base, who, password, '/Message');
        must(listed.status === 200 && listed.body.total === 0, `${who} reads ${listed.body.total} message(s) of Maria's conversation`);
        for (const id of ids) {
          const one = await jsonAs(base, who, password, `/Message/${id}`);
          must(one.status === 403, `${who} opened message #${id} of Maria's conversation: ${one.status}`);
        }
      }
      // Writing outside the form names nobody else as the sender.
      await post('/Message', { match: matchId, sender: '2', body: 'Signed as the provider' });
      const maria = String(thread.body.rows.find((m) => /visit next week/.test(m.body)).sender);
      const signed = (await jsonAs(base, 'maria@portal.test', 'maria123', '/Message')).body.rows.find((m) => m.body === 'Signed as the provider');
      must(!signed || String(signed.sender) === maria, `a student posted a message signed as user #${signed?.sender}`);
      // The match's owner copies follow its student and provider, whatever even an admin posts for them.
      const admin = (p, form) => jsonAs(base, 'admin@portal.test', 'admin123', p, form);
      const forged = { student: '1', provider: '1', studentUser: '3', providerUser: '5' };
      const made = await admin('/Match', forged);
      must(made.status === 200 && made.body.id, `the admin could not create a match: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
      const asMade = await admin(`/Match/${made.body.id}`);
      must(String(asMade.body.studentUser) === '4' && String(asMade.body.providerUser) === '2',
        `a created match kept the posted owners: ${JSON.stringify(asMade.body)}`);
      await admin(`/Match/${made.body.id}`, forged);
      const asEdited = await admin(`/Match/${made.body.id}`);
      must(String(asEdited.body.studentUser) === '4' && String(asEdited.body.providerUser) === '2',
        `an edited match kept the posted owners: ${JSON.stringify(asEdited.body)}`);
      must((await admin(`/Match/${made.body.id}/delete`, {})).status === 200, 'the admin could not remove the test match');
      asGuest();
      must((await login('alice@portal.test', 'alice123')).status === 303, 'alice could not sign in');
      const intrusion = await post('/Message', { match: matchId, body: 'Alice slips into the thread' });
      const seen = await jsonAs(base, 'maria@portal.test', 'maria123', '/Message');
      must(intrusion.status !== 303 && !seen.body.rows.some((m) => /Alice slips/.test(m.body)),
        `another student posted into Maria's conversation: ${intrusion.status} ${intrusion.location}`);
      return "a two-way conversation under the match: the provider's message and Maria's reply both appear; another student and provider read none of it";
    } },
  colorCheck('azure', 'midnightblue'),
];
