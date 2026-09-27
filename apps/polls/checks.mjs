// webgen-bench/000026 — polls: browse options, cast a vote, see live derived results.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigating to the voting page shows all voting options without errors',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const list = await get('/Poll');
      must(list.status === 200 && rows(list.html).length === 2, `expected 2 polls, got ${rows(list.html).length}`);
      const detail = await get('/Poll/1');
      must(detail.status === 200, `poll page returned ${detail.status}`);
      const options = rows(detail.html).filter((r) => /action\/vote/.test(r));
      must(options.length === 3, `expected 3 options, got ${options.length}`);
      must(rowWith(detail.html, 'TypeScript') && rowWith(detail.html, 'Go') && rowWith(detail.html, 'Rust'), 'not all options are shown');
      return "navigating to /Poll/1 shows all 3 options (TypeScript, Go, Rust) with no errors";
    } },
  { task: 'Users can browse different voting options without casting a vote',
    run: async ({ get, rowWith, must }) => {
      const before = await get('/Poll/1');
      const ts = rowWith(before.html, 'TypeScript');
      must(/<td>TypeScript<\/td><td>3<\/td><td>60<\/td>/.test(ts), `TypeScript row unexpectedly changed just by browsing: ${ts}`);
      must(/action\/vote"/.test(before.html), 'no vote button is offered on the options');
      return 'browsing the poll shows every option (with its current tally) unchanged; voting is a separate, explicit action';
    } },
  { task: 'Casting a vote on a selected option records it with a confirmation notification',
    run: async ({ get, follow, rowWith, idOf, must, flashOf }) => {
      const before = await get('/Poll/1');
      const rustId = idOf(before.html, 'Rust', 'Option');
      const r = await follow(`/Option/${rustId}/action/vote`, {});
      must(/Thanks for voting for Rust/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/Which language should we adopt/.test(r.html), `did not land back on the poll: ${r.html.slice(0, 200)}`);
      const row = rowWith(r.html, 'Rust');
      must(/<td>Rust<\/td><td>2<\/td><td>33<\/td>/.test(row), `Rust's tally did not update: ${row}`);
      must(/<th>Total Votes<\/th><td>6<\/td>/.test(r.html), 'the poll total did not follow the new vote');
      return 'voting for Rust is confirmed, and Rust\'s count (1→2) and the poll total (5→6) update immediately';
    } },
  { task: 'The results page shows up-to-date voting results with statistics',
    run: async ({ get, must }) => {
      const { html, status } = await get('/Poll/1');
      must(status === 200, `results page returned ${status}`);
      must(/<td>TypeScript<\/td><td>3<\/td><td>50<\/td>/.test(html), `TypeScript tally/percent wrong: ${html}`);
      must(/<td>Go<\/td><td>1<\/td><td>17<\/td>/.test(html), `Go tally/percent wrong: ${html}`);
      must(/<td>Rust<\/td><td>2<\/td><td>33<\/td>/.test(html), `Rust tally/percent wrong: ${html}`);
      must(/<th>Total Votes<\/th><td>6<\/td>/.test(html), 'the total votes statistic is missing or wrong');
      return 'results show each option\'s vote count and share of the total, all derived live from the votes';
    } },
  colorCheck('white', 'navy'),
];
