// webgen-bench/000075 — team showcase: team intro, projects, skills, contact.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'The team introduction section is present and correct on the homepage',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/');
      must(status === 200, `homepage returned ${status}`);
      must(rows(html).length === 4, `expected 4 team members, got ${rows(html).length}`);
      const row = rowWith(html, 'Nadia Kessler');
      must(row && /Founder &amp; Product Lead/.test(row), `Nadia's row: ${row}`);
      must(rowWith(html, 'Theo Marchand') && /Lead Engineer/.test(rowWith(html, 'Theo Marchand')), 'Theo is missing his role');
      return '4 team members shown on the homepage, each with a name and role';
    } },
  { task: 'Each project in the project showcase can be opened for a detailed view',
    run: async ({ get, idOf, must }) => {
      const list = await get('/Project');
      must(list.status === 200 && /Riverside Market rebrand/.test(list.html), 'the project showcase is missing a project');
      const id = idOf(list.html, 'Fleetwise dispatch dashboard', 'Project');
      const detail = await get(`/Project/${id}`);
      must(detail.status === 200, `project detail returned ${detail.status}`);
      must(/<th>Description<\/th><td>A real-time dispatch dashboard/.test(detail.html), 'the project detail lacks its description');
      must(/<th>Link<\/th><td>https:\/\/example\.test\/fleetwise<\/td>/.test(detail.html), 'the project detail lacks its link');
      return 'opening a project shows its full description and link';
    } },
  { task: "The skill showcase lists the team's skills clearly and without redundancy",
    run: async ({ get, rows, must }) => {
      const { html, status } = await get('/Skill');
      must(status === 200, `skills returned ${status}`);
      const list = rows(html);
      must(list.length === 5, `expected 5 skills, got ${list.length}`);
      const names = list.map((r) => (/<td>([^<]*)<\/td>/.exec(r) || [, ''])[1]);
      must(new Set(names).size === names.length, `duplicate skills listed: ${names}`);
      const design = await get('/Skill?category=design');
      must(rows(design.html).length === 2, 'the category filter does not narrow the skills');
      return '5 distinct skills, each with a category, filterable and free of duplicates';
    } },
  { task: "The contact section displays contact details enabling users to reach the team",
    run: async ({ get, must }) => {
      const { html, status } = await get('/Message');
      must(status === 200, `contact section returned ${status}`);
      must(/hello@teamshow\.test/.test(html) && /\+1 555 0190/.test(html), 'the contact section lacks an email or phone number');
      must(/name="name"/.test(html) === false && /href="\/Message\/new"/.test(html), 'the contact section does not offer a message form');
      return 'contact details (email and phone) are shown, and a message form is offered';
    } },
  { task: 'The navigation menu links to team, projects, skills and contact',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      for (const [href, label] of [['/Member', 'Team'], ['/Project', 'Projects'], ['/Skill', 'Skills'], ['/Message', 'Contact']]) {
        must(new RegExp(`href="${href}">${label}<`).test(nav), `nav is missing ${label}`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      return 'Team, Projects, Skills and Contact are all in the nav and each loads';
    } },
  { task: 'Submitting the contact form succeeds with a confirmation, or fails with clear errors',
    run: async ({ post, follow, must, flashOf }) => {
      const bad = await post('/Message', { name: 'Priya' });
      must(bad.status === 400 && /email is required/.test(bad.html), 'an incomplete contact form was accepted');
      const r = await follow('/Message', { name: 'Priya Shah', email: 'priya@client.test', body: 'We would like a quote for a rebrand.' });
      must(/Your message has been sent successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/Priya Shah/.test(r.html) && /priya@client\.test/.test(r.html), 'the sent message is not recorded');
      return 'an incomplete submission is refused (400); a valid one is confirmed with a success message';
    } },
  colorCheck('whitesmoke', 'darkcyan'),
];
