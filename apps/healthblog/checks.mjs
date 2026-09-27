// WebGen-Bench 000069 — health blog: search, articles, comments, categories, follow.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the homepage of the health blog website and check for the presence of a search bar.',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html, status } = await get('/');
      must(status === 200, `homepage returned ${status}`);
      const articles = await get('/Article');
      must(/name="q"/.test(articles.html), 'the articles list has no search box');
      return 'homepage loads; the articles list carries a search box (name="q")';
    } },
  { task: 'Perform a search for a specific health topic using the search bar.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const hits = rows((await get('/Article?q=sleep')).html);
      must(hits.length === 1 && /Sleep hygiene/.test(hits[0]), `expected the sleep article only, got ${hits.length}`);
      must(rows((await get('/Article?q=walk')).html).some((r) => /short walks matter/.test(r)), 'searching "walk" missed the walking article');
      return 'searching "sleep" and "walk" each return the matching article, titles and all';
    } },
  { task: "Access a specific article from the search results and verify the presence of a comment section.",
    run: async ({ asGuest, get, idOf, must }) => {
      asGuest();
      const results = await get('/Article?q=sleep');
      const id = idOf(results.html, 'Sleep hygiene', 'Article');
      const detail = await get(`/Article/${id}`);
      must(detail.status === 200 && /Comments/.test(detail.html), 'article page has no comment section');
      must(/name="body"/.test(detail.html), 'article page has no comment form');
      return `article #${id} shows a Comments section with a form`;
    } },
  { task: "Post a comment on an article and check the comment's appearance in the comment section.",
    run: async ({ asGuest, get, follow, idOf, must, flashOf }) => {
      asGuest();
      const results = await get('/Article?q=sleep');
      const id = idOf(results.html, 'Sleep hygiene', 'Article');
      const posted = await follow(`/Article/${id}/add/Comment`, { body: 'This finally fixed my insomnia, thank you!' });
      must(/Comment posted/.test(flashOf(posted.html)), `comment was not posted: ${flashOf(posted.html)}`);
      must(/This finally fixed my insomnia, thank you!/.test(posted.html), 'the posted comment does not appear under the article');
      return `comment appears under article #${id} immediately after posting`;
    } },
  { task: 'Browse the category section to view available health topics.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const { html, status } = await get('/Category');
      must(status === 200, `category section returned ${status}`);
      const found = rows(html);
      must(found.length === 3 && /Nutrition/.test(html) && /Fitness/.test(html) && /Mental Health/.test(html), `expected 3 categories, got ${found.length}`);
      const filtered = rows((await get('/Article?category=1')).html);
      must(filtered.length === 1 && /Five habits for a healthier morning/.test(filtered[0]), 'selecting the Nutrition category did not filter articles correctly');
      return `3 categories listed; selecting one filters articles to that topic only`;
    } },
  { task: 'Follow a specific health topic or category from the category list.',
    run: async ({ asGuest, get, follow, idOf, rows, must, flashOf }) => {
      asGuest();
      const list = await get('/Category');
      const id = idOf(list.html, 'Fitness', 'Category');
      const r = await follow(`/Category/${id}/action/follow`, {});
      must(/now following Fitness/.test(flashOf(r.html)), `follow confirmation missing: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.some((row) => row.includes('Fitness')), 'the followed category is not on the personal follow list');
      return `following Fitness is confirmed and added to the personal My Follows list`;
    } },
  colorCheck('mistyrose', 'firebrick'),
];
