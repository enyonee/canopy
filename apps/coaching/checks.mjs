// webgen-bench/000058 — one-to-one coaching: assessment, profile, matching, scheduling, goals.
import { colorCheck } from '../../verify/lib.mjs';

let profileId = null, goalId = null;

export const checks = [
  { task: 'Assess the personality assessment functionality by completing the full assessment',
    run: async ({ post, follow, get, rows, must, flashOf }) => {
      const reg = await post('/register', { email: 'jamie@coaching.test', password: 'jamie123', name: 'Jamie Lee' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const created = await follow('/ClientProfile', { name: 'Jamie Lee', goalArea: 'career', bio: 'Looking for leadership guidance.' });
      const mine = rows(created.html);
      must(mine.length === 1, `expected exactly one profile row, got ${mine.length}`);
      profileId = /\/ClientProfile\/(\d+)/.exec(mine[0])[1];
      const r = await follow(`/ClientProfile/${profileId}/go/submitAssessment`, { q1: 5, q2: 2, q3: 1, q4: 3 });
      must(/Assessment complete — you are a Dominance type; the result is saved to your profile/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const detail = await get(`/ClientProfile/${profileId}`);
      must(/<th>Profile Type<\/th><td>Dominance<\/td>/.test(detail.html), `profile type not saved: ${detail.html}`);
      must(/status">Completed/.test(detail.html), 'the assessment status did not move to completed');
      return 'full assessment (4 answers) submitted; classified as Dominance and saved to the profile';
    } },
  { task: 'Examine the profile creation feature by updating the user profile information',
    run: async ({ get, follow, must, flashOf }) => {
      const form = await get(`/ClientProfile/${profileId}/edit`);
      must(form.status === 200 && /Looking for leadership guidance\./.test(form.html), 'the edit form does not preload the current bio');
      const r = await follow(`/ClientProfile/${profileId}`, { name: 'Jamie Lee', goalArea: 'career',
        bio: 'Updated: focusing on leadership and confidence.' });
      must(/Profile updated/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const detail = await get(`/ClientProfile/${profileId}`);
      must(/Updated: focusing on leadership and confidence\./.test(detail.html), `the update is not shown on reopening: ${detail.html}`);
      return 'profile bio updated, saved and shown again on the profile page';
    } },
  { task: 'Check the coaching and mentorship matching feature by searching for available coaches',
    run: async ({ get, rowWith, rows, must }) => {
      const list = await get('/Suggestion');
      must(list.status === 200, `matching list returned ${list.status}`);
      must(rows(list.html).length === 2, `expected 2 candidate coaches, got ${rows(list.html).length}`);
      const naomi = rowWith(list.html, 'Dr. Naomi Reed');
      must(naomi && /<td>100<\/td><td>Suitable<\/td>/.test(naomi), `Naomi should be a full (100) match on career + Dominance: ${naomi}`);
      const marcus = rowWith(list.html, 'Marcus Bello');
      must(marcus && /<td>0<\/td><td>Not suitable<\/td>/.test(marcus), `Marcus should not match at all (life + Steadiness): ${marcus}`);
      const narrowed = await get('/Suggestion?isSuitable=1');
      must(rows(narrowed.html).length === 1 && rowWith(narrowed.html, 'Dr. Naomi Reed'), 'the suitability filter does not narrow to the real match');
      return 'based on goal area and assessed type: Dr. Naomi Reed is a 100 match, Marcus Bello is not (0), clearly differentiated';
    } },
  { task: 'Test scheduling a new coaching session with a selected coach',
    run: async ({ asGuest, login, get, follow, rows, rowWith, must, flashOf }) => {
      const r = await follow('/CoachProfile/1/action/schedule', { scheduledAt: '2026-10-05T15:00:00.000Z', topic: 'Career transition planning' });
      must(/Session requested with Dr\. Naomi Reed — you will both get a confirmation notification/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const mine = rowWith(r.html, 'Dr. Naomi Reed');
      must(mine && /Career transition planning/.test(mine) && /2026-10-05/.test(mine), `session not on Jamie's calendar: ${mine}`);
      asGuest();
      must((await login('naomi@coaching.test', 'naomi123')).status === 303, 'the coach could not log in');
      const coachSide = rowWith((await get('/Session')).html, 'Career transition planning');
      must(coachSide && /jamie@coaching\.test/.test(coachSide), `session not on the coach's calendar: ${coachSide}`);
      asGuest();
      must((await login('admin@coaching.test', 'admin123')).status === 303, 'admin could not log in');
      const mails = rows((await get('/outbox')).html).filter((x) => x.includes('<td>mail</td>'));
      must(mails.some((m) => /New coaching session booked/.test(m) && /naomi@coaching\.test/.test(m)), `no notification to the coach: ${mails.map((m) => m.slice(0, 160))}`);
      must(mails.some((m) => /Your coaching session is confirmed/.test(m) && /jamie@coaching\.test/.test(m)), `no notification to the client: ${mails.map((m) => m.slice(0, 160))}`);
      return "session booked with Dr. Naomi Reed appears on both Jamie's and Naomi's session list, and each received a notification";
    } },
  { task: 'Evaluate goal-setting and progress tracking by creating and updating a personal goal',
    run: async ({ asGuest, login, follow, rowWith, must, flashOf }) => {
      asGuest();
      must((await login('jamie@coaching.test', 'jamie123')).status === 303, 'jamie could not sign back in');
      const created = await follow('/Goal', { title: 'Get promoted to team lead', targetDate: '2026-12-31', progress: 10, notes: 'Started mentorship.' });
      must(/Goal saved/.test(flashOf(created.html)), `flash: ${flashOf(created.html)}`);
      let row = rowWith(created.html, 'Get promoted to team lead');
      must(row && /<td>10<\/td>/.test(row), `goal not recorded at 10% progress: ${row}`);
      goalId = /\/Goal\/(\d+)/.exec(row)[1];
      const updated = await follow(`/Goal/${goalId}`, { title: 'Get promoted to team lead', targetDate: '2026-12-31', progress: 55, notes: 'Halfway — leading two projects now.' });
      must(/Progress updated/.test(flashOf(updated.html)), `flash: ${flashOf(updated.html)}`);
      row = rowWith(updated.html, 'Get promoted to team lead');
      must(row && /<td>55<\/td>/.test(row) && /leading two projects now/.test(row), `progress update not reflected: ${row}`);
      return 'goal created at 10% and updated to 55%, both changes saved and shown accurately';
    } },
  colorCheck('beige', 'saddlebrown'),
];
