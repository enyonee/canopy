// webgen-bench/000072 — a comprehensive CV: personal info, work experience, skills, education, projects.
import { colorCheck } from '../../verify/lib.mjs';

const navHref = (html, href) => new RegExp(`href="${href.replace('/', '\\/')}"`).test(/<nav>([\s\S]*?)<\/nav>/.exec(html)[1]);

export const checks = [
  { task: "Navigate to the 'Personal Information' section",
    run: async ({ get, must }) => {
      const { html, status } = await get('/Profile');
      must(status === 200, `personal information returned ${status}`);
      must(/Jordan Lee/.test(html) && /Senior Product Engineer/.test(html), 'the name or title is missing');
      must(/jordan\.lee@cv\.test/.test(html) && /\+1 555 0177/.test(html), 'contact details are missing');
      must(/nine years shipping web applications/.test(html), 'the summary is missing');
      return 'name, title, contact details and summary are shown under Personal Information';
    } },
  { task: "Click 'Work Experience' to view detailed work experiences",
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Job');
      must(status === 200, `work experience returned ${status}`);
      must(rows(html).length === 3, `expected 3 roles, got ${rows(html).length}`);
      const row = rowWith(html, 'Senior Product Engineer');
      must(row && /Northwind Software/.test(row) && /2022-03-01/.test(row), `job row: ${row}`);
      must(rows(html)[0].includes('Senior Product Engineer'), 'roles are not ordered most-recent-first');
      const detail = await get('/Job/1');
      must(/<th>Description<\/th><td>Lead a team of four/.test(detail.html), 'responsibilities/achievements missing from the job detail');
      return '3 roles with title, employer, dates and achievements; most recent first';
    } },
  { task: "Access the 'Skills' section from the main navigation",
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      must(navHref(home.html, '/Skill'), 'no Skills link in the nav');
      const { html, status } = await get('/Skill');
      must(status === 200, `skills returned ${status}`);
      must(rows(html).length === 6, `expected 6 skills, got ${rows(html).length}`);
      must(/<td>TypeScript<\/td><td>engineering<\/td><td>expert<\/td>/.test(rowWith(html, 'TypeScript')), 'proficiency level is not shown next to the skill');
      const eng = await get('/Skill?category=engineering');
      must(rows(eng.html).length === 3, 'the category filter does not narrow the skill list');
      return '6 skills with category and proficiency level, filterable by category';
    } },
  { task: "Open the 'Education' section to review the educational background",
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Education');
      must(status === 200, `education returned ${status}`);
      must(rows(html).length === 2, `expected 2 qualifications, got ${rows(html).length}`);
      must(rows(html)[0].includes('Denver Coding Academy'), 'education is not in a logical (most-recent-first) order');
      const row = rowWith(html, 'Willamette College of Engineering');
      must(row && /B\.S\. in Computer Science/.test(row) && /2012-09-01/.test(row) && /2016-05-30/.test(row), `education row: ${row}`);
      return '2 qualifications with institution, degree and dates, most recent first';
    } },
  { task: "Select 'Projects' to view personal projects",
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const { html, status } = await get('/Project');
      must(status === 200, `projects returned ${status}`);
      must(rows(html).length === 3, `expected 3 projects, got ${rows(html).length}`);
      const id = idOf(html, 'Ledgerly', 'Project');
      const detail = await get(`/Project/${id}`);
      must(/<th>Description<\/th><td>An open-source double-entry/.test(detail.html) && /<th>Link<\/th><td>https:\/\/example\.test\/ledgerly<\/td>/.test(detail.html),
        'a project is missing its description or link');
      return '3 projects, each with a title, description and link';
    } },
  { task: 'Use the main navigation to move between all sections',
    run: async ({ get, must }) => {
      const home = await get('/');
      for (const [href, label] of [['/Profile', 'Personal Information'], ['/Job', 'Work Experience'], ['/Skill', 'Skills'], ['/Education', 'Education'], ['/Project', 'Projects']]) {
        must(new RegExp(`href="${href}">${label}<`).test(home.html), `nav is missing ${label} (${href})`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      return 'all 5 sections are reachable from the nav and each returns 200';
    } },
  colorCheck('lightpink', 'mediumvioletred'),
];
