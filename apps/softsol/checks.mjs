// WebGen-Bench 000019 — software solutions + staffing brochure site: nav, search, contact, news, stories.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'The navigation menu includes Home, Software Solutions, Industry News, Customer Stories and Contact, each leading to the right page',
    run: async ({ get, must }) => {
      const { html, status } = await get('/page/home');
      must(status === 200, `homepage returned ${status}`);
      const links = { 'Software Solutions': '/Solution', 'Industry News': '/NewsArticle', 'Customer Stories': '/CustomerStory', 'Contact': '/ContactMessage' };
      for (const [label, href] of Object.entries(links)) {
        must(new RegExp(`href="${href}"[^>]*>${label}`).test(html), `nav is missing "${label}" -> ${href}`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      return 'all five sections present in the nav and reachable';
    } },
  { task: 'Searching finds relevant articles and product descriptions without broken links',
    run: async ({ get, rows, must }) => {
      const products = await get('/Solution?q=invoic');
      must(rows(products.html).length === 1 && /InvoiceFlow/.test(products.html), 'product search does not find InvoiceFlow by relevance');
      const none = await get('/Solution?q=zzzznotfound');
      must(rows(none.html).length === 0, 'an irrelevant search still returns products');
      const articles = await get('/NewsArticle?q=staffing');
      must(rows(articles.html).length === 1 && /Contract staffing overtakes full-time hiring/.test(articles.html), 'article search does not find the staffing article');
      // Round 5's top-level `search` node closes the "no unified/cross-entity
      // search index" Miss: one query, one page, one section per entity.
      const unified = await get('/search?q=staffing');
      must(unified.status === 200, `unified search returned ${unified.status}`);
      for (const heading of ['Software Solutions', 'Industry News', 'Customer Stories'])
        must(new RegExp(`<h3>${heading}</h3>`).test(unified.html), `unified /search is missing a "${heading}" section: ${unified.html}`);
      must(/<h3>Software Solutions<\/h3>(?:(?!<h3>)[\s\S])*HireDesk Staffing/.test(unified.html), 'unified search misses the matching solution');
      must(/<h3>Industry News<\/h3>(?:(?!<h3>)[\s\S])*Contract staffing overtakes full-time hiring/.test(unified.html), 'unified search misses the matching article');
      // A different query proves the Customer Stories section is a real,
      // independently-matching search, not just an always-empty section.
      const unified2 = await get('/search?q=HireDesk');
      must(/<h3>Customer Stories<\/h3>(?:(?!<h3>)[\s\S])*Northgate Clinic Group/.test(unified2.html), 'unified search misses the matching customer story');
      must(/name="q"/.test((await get('/page/home')).html), 'no search box is offered in the page header');
      return 'Solutions search narrows to InvoiceFlow; News search narrows to the staffing article; unified /search finds matches across all three catalogues from one box';
    } },
  { task: 'Submitting the contact form succeeds and the message is sent to the site owner',
    run: async ({ follow, must, flashOf }) => {
      const r = await follow('/ContactMessage', { name: 'Devon Ashby', email: 'devon@example.test', message: 'Interested in HireDesk for a 3-month backend project.' });
      must(r.status === 200, `contact submission returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/get back to you/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(/Devon Ashby/.test(r.html), 'the message was not recorded');
      return 'message recorded and confirmed';
    } },
  { task: 'Industry news and trends content is present and accurate, each with a publication date and author',
    run: async ({ get, rowWith, must }) => {
      const { html, status } = await get('/NewsArticle');
      must(status === 200, `Industry News returned ${status}`);
      const row = rowWith(html, 'Small businesses are adopting AI support tools');
      must(row && /2026-07-18/.test(row) && /Priya Nair/.test(row), `article is missing date/author: ${row}`);
      must(/Marcus Webb/.test(html), 'a second author is missing');
      return 'articles show date and author, e.g. 2026-07-18 by Priya Nair';
    } },
  { task: 'Customer cases and success stories are present with correct, verifiable details',
    run: async ({ get, must }) => {
      const { html, status } = await get('/CustomerStory');
      must(status === 200, `Customer Stories returned ${status}`);
      must(/Bramwell Landscaping/.test(html) && /Northgate Clinic Group/.test(html), 'customer stories are missing');
      const detail = await get(`/CustomerStory/1`);
      must(/overdue invoices dropped from one in four to one in twenty/.test(detail.html), 'story detail lacks verifiable specifics');
      return 'two customer stories with specific, checkable outcomes';
    } },
  colorCheck('mistyrose', 'firebrick'),
];
