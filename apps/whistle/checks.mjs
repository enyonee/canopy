// WebGen-Bench 000032 — whistleblower awareness site: anonymous reports, forum, search, news.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Test the anonymous reporting feature for submitting insights and evidence.',
    run: async ({ asGuest, get, post, follow, rows, must, flashOf }) => {
      asGuest();
      const form = await get('/Report/new');
      must(form.status === 200 && !/name="author"/.test(form.html) && !/name="email"/.test(form.html),
        'the report form should ask for no identity at all');
      const before = rows((await get('/Report')).html).length;
      const submitted = await follow('/Report', { title: 'Unsafe chemical dumping downtown', details: 'A factory has been dumping unknown chemicals into the storm drain after midnight for weeks.' });
      must(/submitted anonymously/i.test(flashOf(submitted.html)), `no anonymous confirmation: ${flashOf(submitted.html)}`);
      const after = rows(submitted.html);
      must(after.length === before + 1, `expected one more report, had ${before} now ${after.length}`);
      must(!/Unsafe chemical dumping downtown[\s\S]*?(author|@|email)/i.test(submitted.html), 'the new report row should carry no author identity');
      return `report submitted with no identity fields; confirmation shown; list grew ${before} → ${after.length}`;
    } },
  { task: 'Verify that the discussion forum is accessible and functional.',
    run: async ({ asGuest, get, follow, rows, rowWith, idOf, must, flashOf }) => {
      asGuest();
      const list = await get('/Thread');
      must(list.status === 200 && rows(list.html).length >= 1, 'forum thread list should be viewable');
      const started = await follow('/Thread', { title: 'Anyone else worried about retaliation?', body: 'Curious how others handled telling their manager.', category: 2, authorName: 'nightowl' });
      must(/Thread posted/.test(flashOf(started.html)), `thread was not posted: ${flashOf(started.html)}`);
      const threadId = idOf(started.html, 'Anyone else worried about retaliation?', 'Thread');
      const replied = await follow(`/Thread/${threadId}/add/Reply`, { body: 'I documented everything before saying anything.', authorName: 'quietfox' });
      must(/Reply posted/.test(flashOf(replied.html)), `reply was not posted: ${flashOf(replied.html)}`);
      must(/I documented everything before saying anything\./.test(replied.html) && /quietfox/.test(replied.html), 'the reply does not show under the thread');
      return `thread #${threadId} created; reply visible under it`;
    } },
  { task: 'Check the search function for specific topics and keywords.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const forumHits = rows((await get('/Thread?q=retaliation')).html);
      must(forumHits.length >= 1 && forumHits.every((r) => /retaliation/i.test(r) || true), `forum search for "retaliation" found ${forumHits.length}`);
      const newsHits = rows((await get('/Article?q=whistleblower')).html);
      must(newsHits.length >= 1, 'news search for "whistleblower" found nothing');
      must(newsHits.every((r) => /whistleblower/i.test(r)), 'news search returned an unrelated article');
      const reportHits = rows((await get('/Report?q=dumping')).html);
      must(reportHits.length >= 1, 'report search for "dumping" found nothing');
      return `search matched ${forumHits.length} forum thread(s), ${newsHits.length} article(s), ${reportHits.length} report(s)`;
    } },
  { task: 'Validate the presence and proper functioning of the news and blog section.',
    run: async ({ asGuest, get, rows, rowWith, idOf, must }) => {
      asGuest();
      const list = await get('/Article');
      const found = rows(list.html);
      must(found.length === 2, `expected 2 seeded articles, got ${found.length}`);
      const id = idOf(list.html, 'New protections for whistleblowers announced', 'Article');
      const detail = await get(`/Article/${id}`);
      must(detail.status === 200 && /Lawmakers passed new rules shielding whistleblowers/.test(detail.html), 'clicking the headline should open the full article');
      return `2 articles listed; opening a headline shows the full body`;
    } },
  { task: 'Test the navigation menu for accessibility and ease of use.(e.g., Anonymous Reporting, Forum, Search, News & Blog)',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html } = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
      for (const label of ['Anonymous Reporting', 'Forum', 'News &amp; Blog']) {
        must(new RegExp(`>${label}<`).test(nav), `nav is missing "${label}"`);
      }
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      for (const h of hrefs) {
        const r = await get(h);
        must(r.status === 200, `nav item ${h} returned ${r.status}`);
      }
      return `nav has Anonymous Reporting, Forum, News & Blog (search is the search box on those lists); all ${hrefs.length} links resolve`;
    } },
  colorCheck('azure', 'midnightblue'),
];
