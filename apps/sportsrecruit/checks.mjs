// WebGen-Bench 000054 — sports recruitment platform. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let athleteEmail = 'ann.sprinter@sportsrecruit.test';
let athletePassword = 'sprint123';
let postedJobId = null;

export const checks = [
  { task: 'Attempt to register as an athlete on the platform using the provided registration form',
    run: async ({ post, get, must, flashOf }) => {
      const r = await post('/register', { email: athleteEmail, password: athletePassword, name: 'Ann Sprinter', sport: 'Track', position: 'Sprinter' });
      must(r.status === 303, `registration returned ${r.status}: ${r.html.slice(0, 200)}`);
      const home = await get(r.location);
      must(new RegExp(`Welcome, ${athleteEmail}`).test(flashOf(home.html)), `no confirmation message: ${flashOf(home.html)}`);
      const dup = await post('/register', { email: athleteEmail, password: 'other123', name: 'Dup' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate email was accepted');
      return `athlete account ${athleteEmail} created with a confirmation message`;
    } },

  { task: 'Log in as a sports organization using valid credentials',
    run: async ({ asGuest, login, get, must }) => {
      asGuest();
      const bad = await login('falcons@sportsrecruit.test', 'wrong-password');
      must(bad.status === 401 && /Wrong login or password/.test(bad.html), 'a wrong password was not rejected with a clear message');
      const r = await login('falcons@sportsrecruit.test', 'falcons123');
      must(r.status === 303, `organization login returned ${r.status}`);
      const dash = await get('/Job');
      must(dash.status === 200 && /Post a job/.test(dash.html), 'the organization does not reach the job posting dashboard');
      return 'FC Falcons signed in without errors and reaches the job listings dashboard';
    } },

  { task: 'Post a new job listing as a sports organization',
    run: async ({ follow, get, rowWith, idOf, must, flashOf }) => {
      const posted = await follow('/Job', { title: 'Assistant Coach', sport: 'Soccer', location: 'Portland, OR',
        description: 'Support match-day preparation and youth academy sessions.', salary: '36000' });
      must(/Job listing posted/.test(flashOf(posted.html)), `no confirmation after posting: ${flashOf(posted.html)}`);
      must(/<th>Title<\/th><td>Assistant Coach<\/td>/.test(posted.html) && /36000\.00/.test(posted.html) && /Portland, OR/.test(posted.html),
        `the posted job's own page does not show what was entered: ${posted.html.slice(0, 300)}`);
      const list = await get('/Job');
      const row = rowWith(list.html, 'Assistant Coach');
      must(row && /Portland, OR/.test(row) && /36000\.00/.test(row) && /status">open|<td>open<\/td>/.test(row), `job listing missing from the catalog: ${row}`);
      postedJobId = idOf(list.html, 'Assistant Coach', 'Job');
      return `job #${postedJobId} "Assistant Coach" appears in the listings exactly as entered`;
    } },

  { task: 'Apply for a job listing as an athlete',
    run: async ({ asGuest, login, get, follow, rows, must, flashOf }) => {
      asGuest();
      must((await login(athleteEmail, athletePassword)).status === 303, 'the newly registered athlete could not sign back in');
      const jobs = await get('/Job');
      must(/action\/apply/.test(jobs.html), 'the athlete is not offered an Apply action on job listings');
      const applied = await follow(`/Job/${postedJobId}/action/apply`, {});
      must(/Application submitted for Assistant Coach/.test(flashOf(applied.html)), `no confirmation after applying: ${flashOf(applied.html)}`);
      const history = rows(applied.html);
      must(history.length === 1 && /Assistant Coach/.test(history[0]) && /submitted/.test(history[0]), `application not logged in account history: ${history[0]}`);
      const jobAfter = await get(`/Job/${postedJobId}`);
      must(/<th>Applicants<\/th><td>1<\/td>/.test(jobAfter.html), 'the job does not count the new applicant');
      return `application logged in Ann's account history; job #${postedJobId} now shows 1 applicant`;
    } },

  { task: 'Send a message from a sports organization to a registered athlete through the platform\'s communication feature',
    run: async ({ asGuest, login, get, post, follow, idOf, must, flashOf }) => {
      asGuest();
      must((await login('falcons@sportsrecruit.test', 'falcons123')).status === 303, 'organization could not sign back in');
      const athletes = await get('/User?role=athlete');
      const athleteId = idOf(athletes.html, athleteEmail, 'User');
      const sent = await follow(`/User/${athleteId}/action/contact`, { body: 'Congratulations on your application — are you available for a trial next week?' });
      must(/Message sent to Ann Sprinter/.test(flashOf(sent.html)), `no confirmation after messaging: ${flashOf(sent.html)}`);
      asGuest();
      must((await login(athleteEmail, athletePassword)).status === 303, 'athlete could not sign back in to check messages');
      const profile = await get('/list/my-profile');
      must(/<td>1<\/td>/.test(profile.html), `the athlete's unread notification did not increase: ${profile.html}`);
      const inbox = await get('/Message');
      must(/available for a trial next week/.test(inbox.html) && />New</.test(inbox.html), 'the message did not reach the athlete\'s inbox as unread');
      return 'organization message reached the athlete\'s inbox with an unread notification (0 → 1)';
    } },

  colorCheck('ghostwhite', 'slategray'),
];
