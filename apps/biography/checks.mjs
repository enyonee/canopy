// webgen-bench/000074 — a biography site: basic info, life experiences, achievements, search.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: "The homepage shows the person's full name, birthdate, and a summary",
    run: async ({ get, must }) => {
      const { html, status } = await get('/');
      must(status === 200, `homepage returned ${status}`);
      must(/Elena Marchetti/.test(html) && /1934-04-12/.test(html), 'name or birthdate is missing from the homepage');
      must(/Nobel Prize in Physics in 1991/.test(html), 'the life/achievements summary is missing');
      return "homepage shows Elena Marchetti's name, birthdate and a summary mentioning her Nobel Prize";
    } },
  { task: 'The "Life Experiences" nav link shows a timeline of key life events',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      must(/href="\/LifeExperience">Life Experiences</.test(/<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1]), 'no Life Experiences link in the nav');
      const { html, status } = await get('/LifeExperience');
      must(status === 200, `life experiences returned ${status}`);
      must(rows(html).length === 4, `expected 4 life events, got ${rows(html).length}`);
      must(rows(html)[0].includes('Born in Turin'), 'the timeline is not in chronological (earliest-first) order');
      const row = rowWith(html, 'Joined the University of Turin faculty');
      must(row && /1961-09-01/.test(row) && /Low Temperature Laboratory/.test(row), `faculty row: ${row}`);
      return '4 life events shown as a chronological timeline with dates and descriptions';
    } },
  { task: 'The "Achievements and Honors" nav link lists achievements with dates and context',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      must(/href="\/Achievement">Achievements and Honors</.test(/<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1]), 'no Achievements and Honors link in the nav');
      const { html, status } = await get('/Achievement');
      must(status === 200, `achievements returned ${status}`);
      must(rows(html).length === 4, `expected 4 achievements, got ${rows(html).length}`);
      const row = rowWith(html, 'Honorary Doctorate, ETH Zurich');
      must(row && /1993-10-01/.test(row) && /<td>honor<\/td>/.test(row), `honorary doctorate row: ${row}`);
      must(rows(html)[0].includes('Honorary Doctorate'), 'achievements are not ordered most-recent-first');
      return '4 achievements with dates and a category, most recent first';
    } },
  { task: 'Searching for a keyword from the biography (e.g. "Nobel Prize") finds it',
    run: async ({ get, rows, rowWith, must }) => {
      const hit = await get('/Achievement?q=Nobel+Prize');
      must(hit.status === 200, `search returned ${hit.status}`);
      must(rows(hit.html).length === 1 && rowWith(hit.html, 'Nobel Prize in Physics'), 'searching "Nobel Prize" did not find the achievement');
      const miss = await get('/Achievement?q=Nonexistent keyword');
      must(rows(miss.html).length === 0, 'an unrelated keyword incorrectly matched something');
      return '"Nobel Prize" finds the matching achievement via the Achievements search box; an unrelated keyword finds nothing';
    } },
  { task: 'Users can move between Home, Life Experiences, Achievements and Search without broken links',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      for (const [href, label] of [['/Person', 'Home'], ['/LifeExperience', 'Life Experiences'], ['/Achievement', 'Achievements and Honors']]) {
        must(new RegExp(`href="${href}">${label}<`).test(nav), `nav is missing ${label}`);
        must((await get(href)).status === 200, `${href} did not load`);
      }
      must((await get('/Achievement?q=Turin')).status === 200, 'the search route (used from the Achievements/Life Experiences pages) did not load');
      return 'Home, Life Experiences and Achievements are all in the nav and load; search works from within those sections';
    } },
  colorCheck('snow', 'dimgray'),
];
