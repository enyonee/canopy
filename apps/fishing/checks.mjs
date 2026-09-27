// webgen-bench/000028 — fishing contests: announcements, registration, results, photos.
import { colorCheck } from '../../verify/lib.mjs';

// A 1x1 transparent PNG, for a genuine multipart upload (no seeded/faked binary).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

export const checks = [
  { task: 'The "Contest Announcements" page shows the latest contest announcement',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const { html, status } = await get('/Contest');
      must(status === 200, `contest announcements returned ${status}`);
      must(rows(html).length === 2, `expected 2 announcements, got ${rows(html).length}`);
      must(rows(html)[0].includes('Winter Ice Derby'), 'the newest announcement is not shown first');
      const row = rowWith(html, 'Winter Ice Derby');
      must(row && /2026-12-06/.test(row) && /Frost Pond/.test(row) && /A half-day ice-fishing derby/.test(row), `derby row: ${row}`);
      return 'the Winter Ice Derby (announced most recently) is listed first, with its date, location and description';
    } },
  { task: 'Registering for a contest with valid details succeeds with a confirmation',
    run: async ({ asGuest, get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Contest');
      const id = idOf(list.html, 'Autumn Bass Classic', 'Contest');
      const page = await get(`/Contest/${id}`);
      must(/name="name"/.test(page.html) && /name="email"/.test(page.html) && /Register for this contest/.test(page.html), 'no registration form on the contest page');
      const bad = await post(`/Contest/${id}/add/Registration`, { name: 'Lee Park' });
      must(bad.status === 400 && /email is required/.test(bad.html), 'registering without an email was accepted');
      const r = await follow(`/Contest/${id}/add/Registration`, { name: 'Lee Park', email: 'lee@anglers.test', phone: '+1 555 0199' });
      must(/You are registered/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Lee Park');
      must(row && /lee@anglers\.test/.test(row), `registration row: ${row}`);
      must(/<th>Registrations<\/th><td>3<\/td>/.test(r.html), 'the registration count did not follow');
      return 'registering with valid details is confirmed and recorded; a missing email is refused (400)';
    } },
  { task: 'The "Contest Results" page shows the latest contest\'s results accurately',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Result');
      must(status === 200, `results returned ${status}`);
      const all = rows(html);
      must(all.length === 3, `expected 3 results, got ${all.length}`);
      must(all[0].includes('Marco Diaz') && /<td>1<\/td>/.test(all[0]), 'the winner (rank 1) is not shown first');
      const winner = rowWith(html, 'Marco Diaz');
      must(winner && /Largemouth bass/.test(winner) && /4\.85/.test(winner), `winner row: ${winner}`);
      const filtered = await get('/Result?contest=1');
      must(rows(filtered.html).length === 3, 'filtering results by contest does not narrow to that contest\'s results');
      return 'results for the Autumn Bass Classic are listed best-rank-first, with angler, species and weight';
    } },
  { task: 'The main menu links to every section without errors',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      for (const [href, label] of [['/Contest', 'Contest Announcements'], ['/Result', 'Contest Results'], ['/Photo', 'Contest Photos']]) {
        must(new RegExp(`href="${href}">${label}<`).test(nav), `nav is missing ${label}`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      return 'Contest Announcements, Contest Results and Contest Photos are all in the nav and each loads';
    } },
  { task: 'The "Contest Photos" section is visible to a signed-out visitor',
    run: async ({ asGuest, upload, get, rows, rowWith, must }) => {
      asGuest();
      const before = await get('/Photo');
      must(before.status === 200, `photos returned ${before.status}`);
      must(rowWith(before.html, 'Marco Diaz weighing in the winning bass'), 'a past contest photo caption is missing');
      const uploaded = await upload('/Photo', { contest: 1, caption: 'This season champion catch' }, { field: 'image', name: 'catch.png', content: PNG });
      must(uploaded.status === 303, `uploading a photo returned ${uploaded.status}`);
      asGuest();
      const after = await get('/Photo');
      const row = rowWith(after.html, 'This season champion catch');
      must(row && /<img class="thumb"/.test(row), `uploaded photo is not shown as an image to a guest: ${row}`);
      return 'a guest sees past photo captions, and a newly uploaded photo renders as a real image, with no login required';
    } },
  colorCheck('mintcream', 'teal'),
];
