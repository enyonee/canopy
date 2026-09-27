// webgen-bench/000071 — designer portfolio: works, about/experience, contact form.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Clicking "Portfolio" in the nav shows multiple design works',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      must(/href="\/Work">Portfolio</.test(nav), `no Portfolio link in the nav: ${nav}`);
      const { html, status } = await get('/Work');
      must(status === 200, `portfolio page returned ${status}`);
      const list = rows(html);
      must(list.length === 5, `expected 5 works, got ${list.length}`);
      const nimbus = rowWith(html, 'Nimbus identity system');
      must(nimbus && /<td>branding<\/td>/.test(nimbus) && /<td>2026<\/td>/.test(nimbus), `nimbus row: ${nimbus}`);
      const detail = await get('/Work/1');
      must(/<th>Description<\/th><td>Full brand identity/.test(detail.html), 'the work detail lacks its description');
      return '5 works listed under Portfolio, each with category and year; detail shows the description';
    } },
  { task: 'The About page correctly provides the designer\'s background and experience',
    run: async ({ get, must }) => {
      const { html, status } = await get('/Profile');
      must(status === 200, `about page returned ${status}`);
      must(/Priya Nandan/.test(html) && /Portland/.test(html), 'the about page lacks the background summary');
      must(/Kettleworks/.test(html) && /Studio Farlow/.test(html) && /BFA in Graphic Design/.test(html), 'the about page lacks the work/education history');
      return 'about page shows Priya Nandan\'s bio and a Kettleworks / Studio Farlow / BFA experience history';
    } },
  { task: 'Submitting the contact form with valid inputs shows a success message',
    run: async ({ get, post, follow, must, flashOf }) => {
      const form = await get('/Message/new');
      must(form.status === 200 && /name="name"/.test(form.html) && /name="email"/.test(form.html) && /name="body"/.test(form.html), 'the contact form is missing a field');
      const bad = await post('/Message', { name: 'Sam' });
      must(bad.status === 400, 'a contact message without an email or body was accepted');
      const r = await follow('/Message', { name: 'Sam Rivera', email: 'sam@buyer.test', body: 'Loved the Aster case study — are you free for a project in November?' });
      must(/Your message has been sent successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/Sam Rivera/.test(r.html) && /sam@buyer\.test/.test(r.html), 'the sent message is not recorded');
      return 'contact form rejects an incomplete submission (400) and confirms a valid one with a success message';
    } },
  { task: "The designer's contact information is clearly visible and accessible",
    run: async ({ get, must }) => {
      const { html } = await get('/Profile');
      must(/priya@designfolio\.test/.test(html) && /\+1 555 0142/.test(html), 'email or phone is not visible on the about page');
      return 'email and phone are shown on the About page, reachable from the main nav';
    } },
  { task: 'Clicking "About" in the nav takes the user to the About page with the designer\'s details',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      must(/href="\/Profile">About</.test(nav), `no About link in the nav: ${nav}`);
      const { html, status } = await get('/Profile');
      must(status === 200 && /Priya Nandan/.test(html), 'the About link does not lead to the designer\'s details');
      return 'the About nav link opens /Profile, showing the designer\'s details';
    } },
  colorCheck('peachpuff', 'indianred'),
];
