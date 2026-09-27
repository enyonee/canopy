// WebGen-Bench 000070 — poetry blog: browse, search, post, comment, categorize.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify the poetry browsing functionality.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const { html, status } = await get('/Poem');
      must(status === 200, `poem list returned ${status}`);
      const found = rows(html);
      must(found.length === 3, `expected 3 seeded poems, got ${found.length}`);
      must(found.every((r) => /Iris Marlow/.test(r)), 'every poem row should show its author');
      must(/Autumn Tide/.test(html) && /Quiet Pond/.test(html) && /Sonnet for a Rainy Evening/.test(html), 'a seeded poem title is missing');
      return `${found.length} poems listed, each with a title and author`;
    } },
  { task: 'Test the search function by searching for a specific poem title.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const hits = rows((await get('/Poem?q=Quiet Pond')).html);
      must(hits.length === 1 && /Quiet Pond/.test(hits[0]), `expected only "Quiet Pond", got ${hits.length}`);
      must(!hits.some((r) => /Autumn Tide|Sonnet for a Rainy Evening/.test(r)), 'search for "Quiet Pond" returned unrelated poems');
      return 'searching "Quiet Pond" returns exactly that poem, nothing unrelated';
    } },
  { task: 'Test the process of posting new poetry.',
    run: async ({ asGuest, get, follow, rows, must, flashOf }) => {
      asGuest();
      const form = await get('/Poem/new');
      must(/name="title"/.test(form.html) && /name="content"/.test(form.html) && /name="tags"/.test(form.html), 'poem form is missing title, content or tags');
      const posted = await follow('/Poem', { title: 'City Lights at Midnight', content: 'Neon signs hum\nabove the empty street—\nsomeone is still awake.', tags: 'city, night', category: 3 });
      must(/Poem posted/.test(flashOf(posted.html)), `poem was not posted: ${flashOf(posted.html)}`);
      must(rows(posted.html).some((r) => /City Lights at Midnight/.test(r)), 'the new poem does not appear on the website');
      return 'poem posted via title/content/tags form, appears on the website';
    } },
  { task: 'Test the functionality for posting a comment on an existing poem.',
    run: async ({ asGuest, get, follow, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Poem');
      const id = idOf(list.html, 'Autumn Tide', 'Poem');
      const posted = await follow(`/Poem/${id}/add/Comment`, { body: 'This captures the season perfectly.' });
      must(/Comment posted/.test(flashOf(posted.html)), `comment was not posted: ${flashOf(posted.html)}`);
      must(/This captures the season perfectly\./.test(posted.html) && /Iris Marlow/.test(posted.html), 'the comment should show its author and appear under the poem');
      must(/20\d\d-\d\d-\d\d/.test(posted.html), 'the comment should carry a timestamp');
      return `comment posted under poem #${id} with author name and timestamp`;
    } },
  { task: 'Verify that users can navigate to different types of poetry categories.',
    run: async ({ asGuest, get, rows, idOf, must }) => {
      asGuest();
      const cats = await get('/Category');
      must(rows(cats.html).length === 4, `expected 4 categories, got ${rows(cats.html).length}`);
      const haikuId = idOf(cats.html, 'Haiku', 'Category');
      const filtered = rows((await get(`/Poem?category=${haikuId}`)).html);
      must(filtered.length === 1 && /Quiet Pond/.test(filtered[0]), `expected only the haiku, got ${filtered.length}`);
      return 'selecting Haiku filters the poem list to that category only';
    } },
  colorCheck('lightgoldenrodyellow', 'olivedrab'),
];
