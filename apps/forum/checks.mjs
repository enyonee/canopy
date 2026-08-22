// WebGen-Bench 000029 — forum. One check per ui_instruct case.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Post a new forum topic; it is visible on the homepage and in its category',
    run: async ({ get, follow, rowWith, must }) => {
      const { html: page } = await follow('/Post', { title: 'Sleep and health', body: 'How much sleep is enough?', category: '1' });
      must(page.includes('Post published successfully'), 'no confirmation after posting');
      const { html } = await get('/Post');
      must(rowWith(html, 'Sleep and health'), 'post is not in the list');
      const inCat = await get('/Post?category=1');
      must(rowWith(inCat.html, 'Sleep and health'), 'post is not visible inside its category');
      return 'post listed on the homepage and under its category';
    } },
  { task: 'Reply to an existing post; the reply shows under it with a confirmation',
    run: async ({ get, follow, idOf, must }) => {
      const { html } = await get('/Post');
      const id = idOf(html, 'Sleep and health');
      const after = await follow(`/Post/${id}/add/Reply`, { body: 'Seven to nine hours.' });
      must(after.html.includes('Reply posted successfully'), 'no confirmation after replying');
      must(after.html.includes('Seven to nine hours.'), 'reply is not shown under the post');
      return 'reply under the original post + confirmation';
    } },
  { task: 'Search posts by the keyword "health"',
    run: async ({ get, follow, rowWith, must }) => {
      await follow('/Post', { title: 'Bus timetable', body: 'When does the 12 leave?', category: '3' });
      const { html } = await get('/Post?q=health');
      must(rowWith(html, 'Sleep and health'), 'keyword search found nothing');
      must(!rowWith(html, 'Bus timetable'), 'search returned an unrelated post');
      return 'matching posts only';
    } },
  { task: 'Browse posts by choosing a category',
    run: async ({ get, rowWith, must }) => {
      const { html } = await get('/Post?category=3');
      must(rowWith(html, 'Bus timetable'), 'category browsing hides its own post');
      must(!rowWith(html, 'Sleep and health'), 'category browsing shows a post from another category');
      return 'only posts of the chosen category';
    } },
  { task: 'User center shows my own posts and replies',
    run: async ({ get, rowWith, must }) => {
      const posts = await get('/list/my-posts');
      must(rowWith(posts.html, 'Sleep and health'), 'my posts are missing from the user center');
      const replies = await get('/list/my-replies');
      must(rowWith(replies.html, 'Seven to nine hours.'), 'my replies are missing from the user center');
      return 'my posts and my replies both listed';
    } },
  { task: 'User center shows personal information and edits persist',
    run: async ({ get, follow, must }) => {
      const { html } = await get('/Profile');
      must(html.includes('me@example.com'), 'personal information is not displayed');
      const after = await follow('/Profile/1', { name: 'Me', email: 'me@example.com', bio: 'Sleep researcher' });
      must(after.html.includes('Sleep researcher'), 'edited personal information did not persist');
      return 'profile shown and editable';
    } },
  colorCheck('ghostwhite', 'slategray'),
];
