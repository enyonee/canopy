// WebGen-Bench 000067 — family event portal: obituaries, mortuaries, condolences, statistics.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the obituary publishing section and submit a new obituary with a title, content, and image.',
    run: async ({ login, upload, get, rows, idOf, must, flashOf }) => {
      must((await login('grace@obit.test', 'grace123')).status === 303, 'grace could not sign in');
      const r = await upload('/Obituary', { title: 'Remembering Eleanor Frost', content: 'Eleanor Frost, beloved teacher and friend to many, passed away peacefully at home.', funeralDate: '2026-10-05', funeralLocation: 'Maple Grove Cemetery' },
        { field: 'image', name: 'eleanor.jpg', content: 'fake-jpeg-bytes' });
      must(r.status === 303, `obituary submission returned ${r.status}: ${r.html.slice(0, 200)}`);
      const dashboard = await get('/list/my-obituaries');
      must(rows(dashboard.html).some((row) => row.includes('Remembering Eleanor Frost')), 'the new obituary is not on the dashboard (my-obituaries)');
      const publicList = await get('/Obituary');
      const id = idOf(publicList.html, 'Remembering Eleanor Frost', 'Obituary');
      const detail = await get(`/Obituary/${id}`);
      must(detail.status === 200 && /Eleanor Frost, beloved teacher/.test(detail.html), 'the obituary is not accessible from the main obituaries page');
      return `obituary #${id} appears on the dashboard and is publicly accessible`;
    } },
  { task: 'Look up the list of local mortuaries available on the website.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const { html, status } = await get('/Mortuary');
      must(status === 200, `mortuary list returned ${status}`);
      const found = rows(html);
      must(found.length === 2, `expected 2 mortuaries, got ${found.length}`);
      must(/Riverside Funeral Home/.test(html) && /12 Riverside Ave/.test(html) && /555 0110/.test(html), 'mortuary row is missing name, location or contact');
      return `${found.length} mortuaries listed with name, location and contact information`;
    } },
  { task: 'Leave a condolence message on an existing obituary.',
    run: async ({ asGuest, get, follow, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Obituary');
      const id = idOf(list.html, 'In loving memory of Arthur Bennett', 'Obituary');
      const posted = await follow(`/Obituary/${id}/add/Condolence`, { authorName: 'Marion Clark', message: 'Sending love and strength to the family during this difficult time.' });
      must(/Condolence posted/.test(flashOf(posted.html)), `condolence was not posted: ${flashOf(posted.html)}`);
      must(/Sending love and strength to the family/.test(posted.html) && /Marion Clark/.test(posted.html), 'the condolence does not show under the obituary');
      return `condolence posted under obituary #${id} and visible to other visitors`;
    } },
  { task: 'Check the statistics page for the statistical analysis of obituary-related data.',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html, status } = await get('/dashboard/stats');
      must(status === 200, `statistics page returned ${status}`);
      must(/<div class="metric"><b>2<\/b>Obituaries published<\/div>/.test(html), `obituary count metric wrong: ${html.match(/Obituaries published[\s\S]{0,40}/)}`);
      must(/Condolences left/.test(html) && /Mortuaries listed/.test(html), 'expected condolence and mortuary metrics on the statistics page');
      must(/Obituaries by month/.test(html), 'expected a breakdown table on the statistics page');
      return 'statistics page shows obituary, condolence and mortuary counts, plus a by-month breakdown';
    } },
  { task: 'Navigate through the website using the main navigation menu.',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html } = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
      for (const label of ['Obituaries', 'Mortuaries']) must(new RegExp(`>${label}<`).test(nav), `nav is missing "${label}"`);
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !['/login', '/register'].includes(h));
      for (const h of hrefs) {
        const r = await get(h);
        must(r.status === 200, `nav item ${h} returned ${r.status}`);
      }
      const second = await get('/Mortuary');
      must(/<nav>/.test(second.html) && new RegExp(`>Obituaries<`).test(/<nav>([\s\S]*?)<\/nav>/.exec(second.html)[1]), 'nav is not consistent across pages');
      return `nav has ${hrefs.length} working links, consistent across pages`;
    } },
  colorCheck('cornsilk', 'peru'),
];
