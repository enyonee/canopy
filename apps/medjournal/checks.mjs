// WebGen-Bench 000086 — a medical journal: search, browse, an author's own
// account, and a PDF an author can attach and a reader can download.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Test the functionality of the search bar by searching for a specific medical term',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/Article?q=insulin');
      must(r.status === 200, `search returned ${r.status}`);
      const found = rows(r.html);
      must(found.length === 2 && found.every((x) => /insulin/i.test(x)), `expected the 2 insulin articles, got ${found.length}`);
      must(rows((await get('/Article')).html).length === 4, 'the unfiltered list should show all 4 seeded articles');
      return '2 of 4 articles match "insulin"; the unfiltered list still shows all 4';
    } },
  { task: "Navigate through the website's main sections using the top navigation menu",
    run: async ({ get, must }) => {
      const home = await get('/');
      must(home.status === 200 && /href="\/page\/about"/.test(home.html), 'the nav has no About link');
      for (const p of ['/page/about', '/Section', '/Article']) {
        const r = await get(p);
        must(r.status === 200, `${p} returned ${r.status}`);
      }
      return 'About, Sections and Articles all load from the top navigation';
    } },
  { task: "Test the account management functionality by attempting to update profile information within an author's account",
    run: async ({ login, get, follow, must }) => {
      must((await login('lee@medjournal.test', 'lee123')).status === 303, 'Dr. Lee could not sign in');
      const mine = await get('/User');
      const id = /\/User\/(\d+)\/edit/.exec(mine.html)?.[1];
      must(id, 'no edit link on the author\'s own account row');
      const saved = await follow(`/User/${id}`, { email: 'lee@medjournal.test', name: 'Dr. Lee', affiliation: 'General Hospital', bio: 'Endocrinologist, now at General.', password: '' });
      must(/Profile updated/.test(saved.html), `save was not confirmed: ${saved.html.slice(0, 200)}`);
      must(/<th>Affiliation<\/th><td>General Hospital<\/td>/.test(saved.html), 'the new affiliation was not saved');
      const again = await get(`/User/${id}`);
      must(/General Hospital/.test(again.html), 'the change did not persist on revisit');
      return 'affiliation changed to "General Hospital" and still there on the next visit';
    } },
  { task: 'Validate the accessibility of the website using an online accessibility checker tool',
    run: async ({ get, must }) => {
      // No external checker runs here; instead assert the structural basics such a
      // tool would flag first: a declared language, and every form control paired
      // with a real <label for="...">.
      const r = await get('/Article/new');
      must(/<html lang="en">/.test(r.html), 'the page does not declare a language');
      const ids = [...r.html.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
      must(ids.length > 0, 'the submission form has no labelled controls to check');
      for (const id of ids) must(new RegExp(`<label for="${id}">`).test(r.html), `control #${id} has no <label for="${id}">`);
      return `lang declared; all ${ids.length} form controls on the submission form have a matching <label for>`;
    } },
  { task: 'Open an article page and verify the download link for article PDFs',
    run: async ({ upload, get, must }) => {
      const created = await upload('/Article',
        { title: 'A note on hypertension', section: '1', abstract: 'A short report with more than twenty characters in it.', keywords: 'hypertension' },
        { field: 'pdf', name: 'article.pdf', content: '%PDF-1.4 minimal test file' });
      must(created.status === 303, `submitting the article with a PDF failed: ${created.status}`);
      const id = /\/Article\/(\d+)/.exec(created.location)[1];
      const detail = await get(`/Article/${id}`);
      must(/<th>Pdf<\/th><td><a href="\/file\/Article\/\d+\/pdf">article\.pdf<\/a><\/td>/.test(detail.html), 'no PDF download link on the article page');
      const file = await get(`/file/Article/${id}/pdf`);
      must(file.status === 200 && /article\.pdf/.test(file.disposition), `PDF did not download: status ${file.status}, disposition ${file.disposition}`);
      return `article #${id} carries a PDF that downloads as article.pdf`;
    } },
  colorCheck('seashell', 'crimson'),
];
