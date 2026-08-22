// WebGen-Bench 000053 — internship portal.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Students browse internships with company, description and location',
    run: async ({ follow, get, rowWith, must }) => {
      await follow('/Internship', { title: 'Firmware intern', company: '1', description: 'Work on sensor drivers', location: 'Remote', active: 'on' });
      const { html } = await get('/Internship');
      const row = rowWith(html, 'Firmware intern');
      must(row, 'the internship is not listed');
      must(row.includes('Helio Systems'), 'company is not shown on the listing');
      must(row.includes('Remote'), 'location is not shown on the listing');
      return 'listing shows title, company and location';
    } },
  { task: 'A student applies for an internship and gets a confirmation',
    run: async ({ get, follow, idOf, must }) => {
      const { html } = await get('/Internship');
      const id = idOf(html, 'Firmware intern');
      const after = await follow(`/Internship/${id}/add/Application`, { student: 'Lena Ford', email: 'lena@example.com', message: 'I built a robot last year.' });
      must(after.html.includes('Application submitted successfully'), 'no confirmation after applying');
      must(after.html.includes('Lena Ford'), 'the application is not attached to the internship');
      return 'application recorded with a confirmation';
    } },
  { task: 'A company posts an internship; it is immediately visible to students',
    run: async ({ follow, get, rowWith, must }) => {
      const after = await follow('/Internship', { title: 'Editorial intern', company: '2', description: 'Proofreading', location: 'Boston', active: 'on' });
      must(after.html.includes('Internship posted successfully'), 'no confirmation after posting');
      const student = await get('/Internship');
      must(rowWith(student.html, 'Editorial intern'), 'the new internship is not on the student browsing page');
      return 'posted and visible on the browsing page';
    } },
  { task: 'Cross-linking between the student and company panels works',
    run: async ({ get, must, base }) => {
      const s = await get('/page/students');
      must(s.html.includes('href="/page/companies"'), 'student panel does not link to the company panel');
      const c = await get('/page/companies');
      must(c.status === 200 && c.html.includes('href="/page/students"'), 'company panel does not link back');
      for (const href of ['/Internship', '/Internship/new', '/Application']) {
        const r = await fetch(base + href, { redirect: 'manual' });
        must(r.status === 200, `panel link ${href} returned ${r.status}`);
      }
      return 'both panels link to each other, every panel link works';
    } },
  colorCheck('mintcream', 'teal'),
];
