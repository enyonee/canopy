// webgen-bench/000004 — basketball analytics: rankings, predictions, recommendations.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the sports data visualization section for basketball.',
    run: async ({ get, must }) => {
      const d = await get('/');
      must(d.status === 200, `homepage (data visualization) returned ${d.status}`);
      must(/<svg role="img"/.test(d.html), 'no chart is rendered on the visualization section');
      must(/Win percentage by team/.test(d.html) && /Matches by status/.test(d.html), 'expected charts are missing');
      must(/<table class="chart-data">/.test(d.html), 'chart data points are missing');
      return 'the homepage renders both basketball charts with their accessible data tables';
    } },
  { task: 'Access the match prediction feature for an upcoming game.',
    run: async ({ get, must }) => {
      const m = await get('/Match/5');
      must(m.status === 200 && /scheduled/.test(m.html), `upcoming match not found: ${m.status}`);
      must(/<th>Predicted Home Win Pct<\/th><td>80<\/td>/.test(m.html) && /<th>Predicted Away Win Pct<\/th><td>20<\/td>/.test(m.html),
        'predicted outcome percentages are missing or wrong');
      return 'the upcoming Ironclads vs Falcons game shows an 80% / 20% predicted outcome';
    } },
  { task: "Use the search function to find a specific team's historical match data.",
    run: async ({ get, rows, must }) => {
      const s = await get('/Match?q=Ironclads&status=final');
      const list = rows(s.html);
      must(list.length === 2, `expected 2 historical Ironclads matches, got ${list.length}`);
      must(list[0].includes('2026-01-10') && list[0].includes('102') && list[0].includes('98'), `first match wrong: ${list[0]}`);
      must(list[1].includes('2026-02-01') && list[1].includes('110') && list[1].includes('80'), `second match wrong: ${list[1]}`);
      return 'two historical Ironclads matches found, sorted chronologically with full scores and dates';
    } },
  { task: 'Check the team rankings page.',
    run: async ({ get, rows, must }) => {
      const r = await get('/Team');
      const list = rows(r.html);
      must(list.length === 6, `expected 6 teams, got ${list.length}`);
      must(list[0].includes('Ironclads') && list[0].includes('<td>79</td>'), `top-ranked team wrong: ${list[0]}`);
      const tied = list.filter((x) => x.includes('<td>64</td>'));
      must(tied.length === 2 && tied.some((x) => x.includes('Wildcats')) && tied.some((x) => x.includes('Vipers')),
        'the tied teams (Wildcats and Vipers, both 45-25) are not both shown at the same win percentage');
      return 'six teams ranked by win %; Wildcats and Vipers correctly tied at 64%';
    } },
  { task: 'Evaluate the player performance section for individual stats.',
    run: async ({ get, rowWith, must }) => {
      const r = await get('/Player');
      must(r.status === 200, `player section returned ${r.status}`);
      const carter = rowWith(r.html, 'J. Carter');
      must(carter && carter.includes('28.40') && carter.includes('6.10') && carter.includes('27.80'), `player stats wrong: ${carter}`);
      return 'points per game, assists per game and rating all shown per player';
    } },
  { task: 'Assess the betting recommendations provided for a specific match.',
    run: async ({ get, must }) => {
      const m = await get('/Match/5');
      must(/Back Ironclads \(80%\)/.test(m.html), 'the recommendation is missing or not actionable');
      must(/<th>Predicted Home Win Pct<\/th><td>80<\/td>/.test(m.html), 'the recommendation is not backed by the shown win-probability statistic');
      return 'recommendation "Back Ironclads (80%)" is shown alongside the statistic that backs it';
    } },
  navCheck(3),
  colorCheck('ghostwhite', 'slategray'),
];
