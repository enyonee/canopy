// webgen-bench/000073 — a link-in-bio site: add/edit/delete links, share the tree, a profile.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Adding a new link puts it in the link tree with the given title and URL',
    run: async ({ get, follow, rows, rowWith, must }) => {
      const r = await follow('/Link', { title: 'My newsletter archive', url: 'https://example.test/archive', position: 5 });
      must(/Link added to your tree/.test((/<p class="flash">([\s\S]*?)<\/p>/.exec(r.html) || [, ''])[1]), 'no confirmation after adding a link');
      const row = rowWith(r.html, 'My newsletter archive');
      must(row && /https:\/\/example\.test\/archive/.test(row), `new link row: ${row}`);
      must(rows((await get('/Link')).html).length === 5, 'the new link is not in the tree');
      return 'the new link appears in the tree with its title and URL';
    } },
  { task: "Editing an existing link's title and URL shows the updated information after saving",
    run: async ({ get, post, follow, rowWith, idOf, must }) => {
      const before = await get('/Link');
      const id = idOf(before.html, 'Latest video', 'Link');
      const form = await get(`/Link/${id}/edit`);
      must(form.status === 200 && /value="Latest video"/.test(form.html), 'the edit form does not preload the link');
      const r = await follow(`/Link/${id}`, { title: 'Latest livestream', url: 'https://example.test/livestream', position: 2 });
      must(/Link updated/.test((/<p class="flash">([\s\S]*?)<\/p>/.exec(r.html) || [, ''])[1]), 'no confirmation after editing');
      const row = rowWith(r.html, 'Latest livestream');
      must(row && /https:\/\/example\.test\/livestream/.test(row), `edited link row: ${row}`);
      must(!rowWith(r.html, 'Latest video'), 'the old title is still shown');
      return 'the link shows the new title and URL after saving';
    } },
  { task: 'Deleting an existing link removes it from the tree with no residual data',
    run: async ({ get, post, rowWith, idOf, rows, must }) => {
      const before = await get('/Link');
      const id = idOf(before.html, 'Newsletter signup', 'Link');
      const r = await post(`/Link/${id}/delete`, {});
      must(r.status === 303, `delete returned ${r.status}`);
      const after = await get('/Link');
      must(!rowWith(after.html, 'Newsletter signup'), 'the deleted link is still listed');
      must((await get(`/Link/${id}`)).status === 404, 'the deleted link page still exists');
      return 'the link is gone from the tree and its page 404s';
    } },
  { task: "The link tree's shareable link can be found and opened by anyone",
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const home = await get('/page/home');
      must(/href="\/Link"/.test(home.html) && /\/Link/.test(home.html), 'the home page does not point to the shareable tree address');
      const tree = await get('/Link');
      must(tree.status === 200 && /Link Tree/.test(tree.html), 'the shareable link does not open the tree for a guest');
      return 'the home page names /Link as the shareable address, and a guest can open it directly';
    } },
  { task: 'Adding a link with incomplete fields is rejected with a validation error',
    run: async ({ post, must }) => {
      const noUrl = await post('/Link', { title: 'Broken link' });
      must(noUrl.status === 400 && /url is required/i.test(noUrl.html), `missing url was accepted: ${noUrl.status}`);
      const noTitle = await post('/Link', { url: 'https://example.test/x' });
      must(noTitle.status === 400 && /title is required/i.test(noTitle.html), `missing title was accepted: ${noTitle.status}`);
      return 'a link missing its title or URL is refused with a validation message, not saved';
    } },
  { task: 'Navigating between the home page, the link tree dashboard, and the user profile all work',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.status === 200, `home returned ${home.status}`);
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      must(/href="\/page\/home">Home</.test(nav) && /href="\/Link">Link Tree</.test(nav) && /href="\/Profile">Profile</.test(nav), `nav missing a section: ${nav}`);
      must((await get('/Link')).status === 200 && (await get('/Profile')).status === 200, 'the link tree or profile page failed to load');
      return 'Home, Link Tree and Profile are all in the nav and all load';
    } },
  colorCheck('papayawhip', 'darkorange'),
];
