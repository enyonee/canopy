// webgen-bench/000095 — ringtones and wallpapers: search, download, history, collection, categories.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Use the search function to find a specific ringtone using a keyword',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Content?q=Thunder');
      must(status === 200, `search returned ${status}`);
      must(rows(html).length === 1, `expected 1 result for "Thunder", got ${rows(html).length}`);
      const row = rowWith(html, 'Thunder Riff');
      must(row && /<td>ringtone<\/td>/.test(row) && /Rock/.test(row), `search result row: ${row}`);
      return 'searching "Thunder" returns the one matching ringtone with its title and category';
    } },

  { task: 'Browse a category of wallpapers and attempt to download one',
    run: async ({ asGuest, login, post, get, follow, rows, rowWith, idOf, must, flashOf }) => {
      const wallpapers = await get('/Content?kind=wallpaper');
      must(rows(wallpapers.html).length === 3, `expected 3 wallpapers, got ${rows(wallpapers.html).length}`);
      const id = idOf(wallpapers.html, 'Ocean Sunset', 'Content');
      asGuest();
      must((await post(`/Content/${id}/action/download`, {})).status === 403, 'a guest could download');
      const reg = await post('/register', { email: 'jo@ringtones.test', password: 'jo12345', name: 'Jo' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const r = await follow(`/Content/${id}/action/download`, {});
      must(/Download recorded for Ocean Sunset/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Downloads<\/th><td>1<\/td>/.test(r.html), `download count did not increment: ${r.html.slice(0, 400)}`);
      return 'a guest is blocked from downloading; after registering, downloading Ocean Sunset confirms immediately and its download count becomes 1';
    } },

  { task: 'Navigate to the user profile section to view the download history',
    run: async ({ get, idOf, must }) => {
      const wallpapers = await get('/Content?kind=wallpaper');
      const id = idOf(wallpapers.html, 'Ocean Sunset', 'Content');
      const { html, status } = await get('/list/my-downloads');
      must(status === 200, `download history returned ${status}`);
      must(/Ocean Sunset/.test(html), 'the downloaded item is missing from the history');
      must(/<td>20\d\d-\d\d-\d\dT[\d:.]+Z<\/td>/.test(html), 'the download history has no timestamp');
      return "Jo's download history lists Ocean Sunset with the date and time it was downloaded";
    } },

  { task: 'Add a ringtone to the collection for future reference without downloading it',
    run: async ({ get, follow, idOf, must, flashOf }) => {
      const ringtone = await get('/Content?kind=ringtone&q=Forest');
      const id = idOf(ringtone.html, 'Forest Rain', 'Content');
      const before = await get('/Content/1');
      must(!/<a href="\/Content\/1">Forest Rain/.test(before.html), 'sanity check target changed');
      const r = await follow(`/Content/${id}/action/addToCollection`, {});
      must(/Forest Rain added to your collection/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Downloads<\/th><td>0<\/td>/.test(r.html), 'adding to the collection incorrectly counted as a download');
      const collection = await get('/list/my-collection');
      must(collection.status === 200 && /Forest Rain/.test(collection.html), 'the collection list does not show Forest Rain');
      return 'Forest Rain is added to the collection (download count stays 0) and appears in My Collection';
    } },

  { task: 'Test the categorization feature by selecting a category from the menu',
    run: async ({ get, rows, rowWith, must }) => {
      const catList = await get('/Content');
      const nature = /href="\/Content\?category=(\d+)">Nature</.exec(catList.html);
      must(nature, `no Nature category filter link found: ${catList.html.slice(0, 500)}`);
      const id = nature[1];
      const { html, status } = await get(`/Content?category=${id}`);
      must(status === 200, `category filter returned ${status}`);
      must(rows(html).length === 3, `expected 3 items in Nature, got ${rows(html).length}`);
      must(rowWith(html, 'Forest Rain') && rowWith(html, 'Ocean Sunset') && rowWith(html, 'Mountain Peak'), `Nature category rows: ${html.slice(0, 600)}`);
      return 'selecting the Nature category from the filter menu shows exactly its 3 ringtones/wallpapers';
    } },

  colorCheck('lightgoldenrodyellow', 'olivedrab'),
];
