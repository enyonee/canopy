// webgen-bench/000094 — animal spotter: species colour codes, detections, personalised SMS alerts.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let alertRuleId = null;

export const checks = [
  { task: 'Verify SMS alert functionality by setting an alert condition for a specific animal.',
    run: async ({ asGuest, post, login, get, rows, must }) => {
      asGuest();
      const reg = await post('/register', { email: 'alice@spot.test', password: 'alice123', name: 'Alice' });
      must(reg.status === 303, `registering failed: ${reg.status}`);
      const made = await post('/AlertRule', { species: 3, phone: '+15559876543', active: 1 });
      must(made.status === 303, `setting the alert failed: ${made.status}: ${made.html.slice(0, 200)}`);
      alertRuleId = /\/AlertRule\/(\d+)/.exec(made.location)?.[1] ?? null;
      asGuest();
      const adm = await login('admin@animalspotter.test', 'admin123');
      must(adm.status === 303, 'admin could not log in to trigger the camera');
      const ran = await post('/schedule/detect/run', {});
      must(ran.status === 303, `triggering a detection failed: ${ran.status}`);
      const outbox = await get('/outbox');
      const sms = rows(outbox.html).filter((r) => r.includes('<td>sms</td>'));
      must(sms.length === 1, `expected exactly 1 SMS in the outbox, got ${sms.length}`);
      must(sms[0].includes('+15559876543') && /Fox detected at Trail Cam 1/.test(sms[0]),
        `the SMS does not carry the right animal and location: ${sms[0]}`);
      return 'a Fox detection matched the alert rule and an SMS to +15559876543 landed in the outbox with the right info';
    } },
  { task: 'Assign and verify a color code for an identified animal in the video analysis.',
    run: async ({ get, rowWith, must }) => {
      const list = await get('/Detection');
      const bear = rowWith(list.html, 'Creek Bend');
      must(bear && bear.includes('Bear') && bear.includes('<td>Black</td>'), `the Bear detection is not highlighted with its Black colour code: ${bear}`);
      const fox = rowWith(list.html, 'Trail Cam 1');
      must(fox && fox.includes('Fox') && fox.includes('<td>Orange</td>'), `the Fox detection is not highlighted with its Orange colour code: ${fox}`);
      const species = await get('/Species');
      must(rowWith(species.html, 'Bear')?.includes('<td>Black</td>'), 'the species catalog does not show the Bear colour code');
      return 'each animal keeps its own colour code (Bear=Black, Fox=Orange) in both the catalog and its detection record';
    } },
  { task: 'Browse the detection records page.',
    run: async ({ get, rows, must }) => {
      const r = await get('/Detection');
      must(r.status === 200, `detection records returned ${r.status}`);
      const list = rows(r.html);
      must(list.length === 6, `expected 6 detections (5 seeded + 1 live), got ${list.length}`);
      must(list.every((x) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(x)), 'not every detection shows a timestamp');
      must(list.every((x) => /Wolf|Deer|Fox|Bear|Eagle|Coyote/.test(x)), 'not every detection names its species');
      must(list.every((x) => /Gray|Brown|Orange|Black|White|Tan/.test(x)), 'not every detection shows its colour code');
      return 'the full detection history (6 records) shows timestamp, species and colour code for every entry';
    } },
  { task: 'View detailed information for a specific animal from the records.',
    run: async ({ get, idOf, must }) => {
      const list = await get('/Detection');
      const id = idOf(list.html, 'Cliff Overlook', 'Species');
      const detail = await get(`/Species/${id}`);
      must(/Eagle/.test(detail.html), 'opening the species from a detection did not land on the right species');
      must(/<th>Habitat<\/th><td>Cliffs<\/td>/.test(detail.html) && /large bird of prey/.test(detail.html),
        'the species detail is missing clear informative content');
      return 'clicking through from a detection opens the Eagle species page with habitat and a clear description';
    } },
  { task: 'Set and modify personalized animal alert criteria from the user settings.',
    run: async ({ asGuest, login, get, post, must }) => {
      asGuest();
      const r = await login('alice@spot.test', 'alice123');
      must(r.status === 303, 'alice could not log in to manage her alerts');
      const mine = await get('/AlertRule');
      must(/\+15559876543/.test(mine.html), 'the alert set earlier is not visible under the user\'s own settings');
      const edited = await post(`/AlertRule/${alertRuleId}`, { species: 3, phone: '+15551112222', active: 0 });
      must(edited.status === 303, `editing the alert failed: ${edited.status}: ${edited.html.slice(0, 200)}`);
      const after = await get(`/AlertRule/${alertRuleId}`);
      must(/\+15551112222/.test(after.html) && /<th>Active<\/th><td>No<\/td>/.test(after.html), 'the edited alert criteria are not reflected immediately');
      return 'alice\'s alert (phone, active) is editable and the change is reflected immediately';
    } },
  navCheck(3),
  colorCheck('mistyrose', 'firebrick'),
];
