// WebGen-Bench 000064 — shipping industry news blog: news, companies, events, newsletter, ad backend.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the news section and verify the presence of recent articles.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const { html, status } = await get('/Article');
      must(status === 200, `news section returned ${status}`);
      const found = rows(html);
      must(found.length === 3, `expected 3 articles, got ${found.length}`);
      must(found.every((r) => /<td>20\d\d-\d\d-\d\d<\/td>/.test(r)), 'every article row should show a publication date');
      must(/Port of Rotterdam sets new container record/.test(html) && /Container throughput hit an all-time high/.test(html),
        'article row is missing title or summary');
      return `${found.length} articles listed, each with title, date and summary`;
    } },
  { task: 'Access a company profile from the company information section.',
    run: async ({ asGuest, get, rows, idOf, must }) => {
      asGuest();
      const list = await get('/Company');
      must(rows(list.html).length === 2, `expected 2 companies, got ${rows(list.html).length}`);
      const id = idOf(list.html, 'Meridian Shipping Lines', 'Company');
      const detail = await get(`/Company/${id}`);
      must(detail.status === 200, `company detail returned ${detail.status}`);
      must(/Founded in 1974/.test(detail.html), 'company history is missing');
      must(/Laura Chen/.test(detail.html), 'key executives are missing');
      must(/info@meridianshipping\.test/.test(detail.html) && /555 0134/.test(detail.html), 'contact information is missing');
      return 'company profile shows history, executives and contact information';
    } },
  { task: 'Attempt to subscribe to the newsletter using a valid email address.',
    run: async ({ asGuest, follow, flashOf, must }) => {
      asGuest();
      const r = await follow('/Subscriber', { email: 'reader@example.test' });
      must(/subscribed to the newsletter/i.test(flashOf(r.html)), `no subscription confirmation: ${flashOf(r.html)}`);
      return 'subscribing shows a confirmation message';
    } },
  { task: 'Go to the events section and view details of a listed event.',
    run: async ({ asGuest, get, rows, idOf, must } ) => {
      asGuest();
      const list = await get('/Event');
      must(rows(list.html).length === 2, `expected 2 events, got ${rows(list.html).length}`);
      const id = idOf(list.html, 'Global Maritime Logistics Summit', 'Event');
      const detail = await get(`/Event/${id}`);
      must(detail.status === 200 && /2026-10-14/.test(detail.html) && /09:00/.test(detail.html) && /Rotterdam Convention Centre/.test(detail.html),
        'event details are missing date, time or location');
      must(/discuss the future of container shipping/.test(detail.html), 'event description is missing');
      return 'event detail shows date, time, location and description';
    } },
  { task: 'Test the main navigation bar links to ensure they redirect to correct sections.',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html } = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
      for (const label of ['News', 'Company Profiles', 'Events']) must(new RegExp(`>${label}<`).test(nav), `nav is missing "${label}"`);
      for (const [label, path] of [['News', '/Article'], ['Company Profiles', '/Company'], ['Events', '/Event']]) {
        const r = await get(path);
        must(r.status === 200, `${label} (${path}) returned ${r.status}`);
      }
      return 'News, Company Profiles and Events all reachable from the nav without errors';
    } },
  { task: 'Verify ad space management in the backend by placing an advertisement and checking its display on the main site.',
    run: async ({ asGuest, login, get, follow, rows, must, flashOf }) => {
      asGuest();
      const denied = await get('/Ad/new');
      must(/\/login/.test(denied.location || '') || denied.status === 403, `a guest should not reach the admin ad form (got ${denied.status}, ${denied.location})`);
      must((await login('admin@shipnews.test', 'admin123')).status === 303, 'admin could not sign in');
      const placed = await follow('/Ad', { title: 'Northstar Marine — cargo insurance quotes', linkUrl: 'https://northstarmarine.test/insurance', active: 'on' });
      must(/Advertisement placed/.test(flashOf(placed.html)), `ad was not created: ${flashOf(placed.html)}`);
      asGuest();
      const publicAds = rows((await get('/Ad')).html);
      must(publicAds.length === 2, `expected 2 active ads on the public page, got ${publicAds.length}`);
      must(publicAds.some((r) => /Northstar Marine — cargo insurance quotes/.test(r)), 'the newly placed ad is not shown in the public ad space');
      return 'admin placed an ad; it now shows in the public ad space alongside the seeded one';
    } },
  colorCheck('oldlace', 'rosybrown'),
];
