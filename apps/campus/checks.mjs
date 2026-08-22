// WebGen-Bench 000031 — anonymous campus discussion.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Post anonymously; no personal information is attached',
    run: async ({ get, follow, rowWith, must }) => {
      const after = await follow('/Post', { body: 'Anyone up for a math study session?', topic: '1' });
      must(after.html.includes('Posted anonymously'), 'no anonymity confirmation');
      const { html } = await get('/Post');
      must(rowWith(html, 'math study session'), 'post is not in the forum');
      must(!/author/i.test(html), 'an author column leaked into the list');
      return 'post visible, no author anywhere';
    } },
  { task: 'Reply anonymously under an existing post',
    run: async ({ get, follow, idOf, must }) => {
      const { html } = await get('/Post');
      const id = idOf(html, 'math study session');
      const after = await follow(`/Post/${id}/add/Reply`, { body: 'Count me in.' });
      must(after.html.includes('Reply posted anonymously'), 'no confirmation after replying');
      must(after.html.includes('Count me in.'), 'reply is not shown under the post');
      return 'reply under the post, still anonymous';
    } },
  { task: 'Search posts by the keyword "math"',
    run: async ({ get, follow, rowWith, must }) => {
      await follow('/Post', { body: 'Lost my dorm key near block B', topic: '2' });
      const { html } = await get('/Post?q=math');
      must(rowWith(html, 'math study session'), 'search found nothing');
      must(!rowWith(html, 'dorm key'), 'search returned an unrelated post');
      return 'only matching posts';
    } },
  { task: 'Follow a topic of interest',
    run: async ({ follow, get, rowWith, must }) => {
      const after = await follow('/Topic/1/action/follow', {});
      must(after.html.includes('now following'), 'no confirmation that the topic is followed');
      const { html } = await get('/list/following');
      must(rowWith(html, 'math'), 'followed topic is not listed');
      return 'topic followed and listed';
    } },
  navCheck(4),
  { task: 'A new post in a followed topic produces a notification',
    run: async ({ get, follow, rowWith, must }) => {
      const before = (await get('/Notification')).html;
      const had = (before.match(/<tr class=/g) || []).length;
      await follow('/Post', { body: 'Extra math seminar on Friday', topic: '1' });
      const { html } = await get('/Notification');
      const now = (html.match(/<tr class=/g) || []).length;
      must(now > had, 'no notification was created for the new post');
      must(rowWith(html, 'New anonymous post'), 'notification text is missing');
      must(!/@|author|name/i.test(/<tbody>([\s\S]*?)<\/tbody>/.exec(html)[1]), 'notification leaks personal details');
      return `${now - had} notification created, no personal details`;
    } },
  colorCheck('honeydew', 'darkolivegreen'),
];
