// WebGen-Bench 000059 — virtual study groups.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Join an existing study group; it shows under "My groups"',
    run: async ({ follow, get, rowWith, must }) => {
      const after = await follow('/Group/1/action/join', {});
      must(after.html.includes('You joined the study group'), 'no confirmation after joining');
      const { html } = await get('/list/my-groups');
      must(rowWith(html, 'Algebra study group'), 'the joined group is missing from My groups');
      return 'joined and listed in the personal center';
    } },
  { task: 'Shared resources are reachable and downloadable',
    run: async ({ follow, get, must }) => {
      const after = await follow('/Group/1/add/Resource', { title: 'Week 1 problem set', link: 'https://example.org/set1.pdf' });
      must(after.html.includes('Resource shared successfully'), 'no confirmation after sharing');
      must(after.html.includes('https://example.org/set1.pdf'), 'the resource link is not shown');
      const { html } = await get('/Resource');
      must(html.includes('Week 1 problem set'), 'the resource is missing from the resource list');
      return 'link recorded and listed (see the report: real file download is not supported)';
    } },
  { task: 'Post to the project discussion of a group',
    run: async ({ follow, must }) => {
      const after = await follow('/Group/1/add/Discussion', { text: 'Let us split the problem set in two.' });
      must(after.html.includes('posted to the group discussion'), 'no confirmation after posting');
      must(after.html.includes('Let us split the problem set in two.'), 'the message is not in the discussion');
      must(after.html.includes('Me'), 'the message is not attributed to the current user');
      return 'message posted, visible and attributed';
    } },
  { task: 'The personal center shows and updates personal information',
    run: async ({ get, follow, must }) => {
      const before = await get('/Profile');
      must(before.html.includes('me@example.com'), 'personal information is not displayed');
      const after = await follow('/Profile/1', { name: 'Me', email: 'me@example.com', bio: 'Second year, maths' });
      must(after.html.includes('Your personal information was saved') || after.html.includes('updated successfully'),
        'no confirmation after saving the profile');
      must(after.html.includes('Second year, maths'), 'the profile change did not persist');
      return 'profile shown, updated and confirmed';
    } },
  colorCheck('aliceblue', 'steelblue'),
];
