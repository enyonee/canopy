// webgen-bench/000017 — Fundraiser Day one-page site: Testimonial/Offer/
// CompanyInfo rows, a home landing page carrying the introduction copy and
// the auto-advancing carousel widget (plugins/fundraiser.mjs).
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Check the accuracy of content within the introduction section about Fundraiser Day',
    run: async ({ base, get, must }) => {
      const { html, status } = await get('/');
      must(status === 200, `home page returned ${status}`);
      must(/Fundraiser Day/.test(html), 'the home page does not even mention Fundraiser Day');
      must(/single biggest day of giving|turning an afternoon/.test(html), 'the introduction does not explain the purpose of the event');
      must(/causes|food bank|youth sports/.test(html), 'the introduction does not explain the event\'s significance (what the money is for)');
      // The introduction section also carries the one real widget on this page:
      // the auto-advancing offers carousel — confirmed live, in a real browser,
      // per the round-4 rule that a widget app needs at least one openBrowser check.
      const b = await openBrowser(`${base}/`);
      try {
        await b.until(`document.querySelector('.carousel')`);
        const first = await b.eval(`document.querySelector('[data-slide-title]').textContent`);
        await b.until(`document.querySelector('[data-slide-title]') && document.querySelector('[data-slide-title]').textContent !== ${JSON.stringify(first)}`, 4000);
        const second = await b.eval(`document.querySelector('[data-slide-title]').textContent`);
        must(second !== first, `the offers carousel did not change its visible slide over time: stayed on "${first}"`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'home page introduces Fundraiser Day (purpose + significance) and its offers carousel auto-advances to a new slide over time';
    } },
  { task: 'Validate the presence and correctness of fundraiser testimonials',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Testimonial');
      must(status === 200, `testimonials returned ${status}`);
      must(rows(html).length === 3, `expected 3 testimonials, got ${rows(html).length}`);
      const maria = rowWith(html, 'Maria Gonzalez');
      must(maria && /raise more in one afternoon/.test(maria), `testimonial content missing or wrong: ${maria}`);
      const detail = await get('/Testimonial/1');
      must(/<th>Result<\/th><td>Raised \$4,200 for the local food bank<\/td>/.test(detail.html), 'a testimonial\'s result is not shown on its detail page');
      must(!/href="\/Testimonial\/new"/.test(html), 'visitors are offered to fabricate their own testimonial');
      return '3 real, positive testimonials with named authors and a concrete outcome each; no fake-submission form';
    } },
  { task: 'Ensure that the company information section is visible and accurate',
    run: async ({ get, must }) => {
      const list = await get('/CompanyInfo');
      must(list.status === 200 && /Hopewell Community Foundation/.test(list.html), 'the company information section is not visible');
      const detail = await get('/CompanyInfo/1');
      must(/<th>Mission<\/th><td>We connect generous people/.test(detail.html), 'the mission is missing from company information');
      must(/<th>Role<\/th><td>Hopewell Community Foundation founded and organizes Fundraiser Day/.test(detail.html), 'the company\'s role in organizing Fundraiser Day is missing');
      must(/<th>Founded Year<\/th><td>2011<\/td>/.test(detail.html) && /<th>Email<\/th><td>hello@hopewellfoundation\.test<\/td>/.test(detail.html), 'company background/contact details are missing');
      return 'company information shows mission, founding year, contact details and its role organizing Fundraiser Day';
    } },
  { task: 'Test the website\'s navigation to ensure users can easily access between the introduction, testimonials, offers, and company information sections',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      for (const [label, href] of [['Testimonials', '/Testimonial'], ['Offers', '/Offer'], ['Company Information', '/CompanyInfo']]) {
        must(new RegExp(`href="${href}"`).test(nav), `nav is missing a link to ${label} (${href})`);
      }
      for (const href of ['/Testimonial', '/Offer', '/CompanyInfo']) {
        const r = await get(href);
        must(r.status === 200, `${href} returned ${r.status}`);
        must(/href="\/"/.test(r.html) || /<h1>Fundraiser Day<\/h1>/.test(r.html), `${href} offers no way back to the home page via the header`);
      }
      must(/href="\/Testimonial"/.test(home.html) && /href="\/Offer"/.test(home.html) && /href="\/CompanyInfo"/.test(home.html), 'the home page itself does not link to the three sections');
      return 'introduction (home), testimonials, offers and company information all reachable from the nav and from home, every link 200';
    } },
  { task: 'Assess the website\'s content for relevance to the Fundraiser Day promotion',
    run: async ({ get, must }) => {
      const pages = await Promise.all(['/', '/Testimonial', '/Offer', '/CompanyInfo'].map((p) => get(p)));
      const combined = pages.map((p) => p.html).join(' ');
      must(/Fundraiser Day/.test(combined), 'Fundraiser Day is not mentioned across the site\'s content');
      must(!/lorem ipsum/i.test(combined), 'placeholder lorem-ipsum text leaked into the site');
      return 'every section\'s content names and promotes Fundraiser Day; no unrelated filler text';
    } },
  colorCheck('cornsilk', 'peru'),
];
