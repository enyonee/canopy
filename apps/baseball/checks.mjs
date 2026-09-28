// Acceptance checks for webgen-bench/000012 (baseball), one per ui_instruct
// case in order, the last being the colour check. Uses ./engine.mjs (the
// same seeded simulation plugins/baseball.mjs runs) as an oracle to predict
// the exact score and play-by-play, the same "deterministic randomness"
// pattern as apps/chess/apps/poker/apps/game2048.
import { colorCheck, navCheck } from '../../verify/lib.mjs';
import { simulateGame } from './engine.mjs';

const jsonGet = async (base, path) => { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json() }; };
const jsonPost = async (base, path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
  return { status: r.status, body: await r.json() };
};

async function makeTeam(base, name, defenseStrategy, players) {
  const team = await jsonPost(base, '/Team', { name, budget: '50000', trainingBudget: '10000', defenseStrategy });
  const id = team.body.id;
  for (const p of players) await jsonPost(base, `/Team/${id}/add/Player`, { name: p.name, position: p.position || '1B', battingOrder: String(p.battingOrder), rating: String(p.rating) });
  const roster = (await jsonGet(base, `/Player?team=${id}`)).body?.rows
    || (await jsonGet(base, `/Player`)).body.rows.filter((r) => String(r.team) === String(id));
  return { id, roster: roster.sort((a, b) => a.battingOrder - b.battingOrder) };
}

export const checks = [
  { task: 'Selecting a player in the statistics section shows their batting average, home runs and RBIs',
    run: async ({ base, must }) => {
      const players = (await jsonGet(base, '/Player')).body.rows;
      const withAtBats = players.find((p) => p.atBats > 0);
      must(withAtBats, 'no seeded player has any at-bats to show a statistic for');
      const detail = await jsonGet(base, `/Player/${withAtBats.id}`);
      must(detail.status === 200, `player detail did not load: ${detail.status}`);
      const expectedAvg = Math.round((withAtBats.hits * 1000) / withAtBats.atBats);
      must(detail.body.battingAvg === expectedAvg, `battingAvg is ${detail.body.battingAvg}, expected ${expectedAvg} from ${withAtBats.hits}/${withAtBats.atBats}`);
      must('homeRuns' in detail.body && 'rbis' in detail.body, 'home runs / RBIs are not in the player detail');
      const html = (await (await fetch(`${base}/Player/${withAtBats.id}`)).text());
      must(/Home Runs/.test(html) && /Rbis|RBIs/i.test(html) && /Batting Avg/.test(html), 'the detail page does not show batting average, home runs and RBIs');
      return `Player #${withAtBats.id} (${withAtBats.name}): battingAvg=${expectedAvg}, homeRuns=${detail.body.homeRuns}, rbis=${detail.body.rbis}, all shown on the detail page`;
    } },

  { task: 'Initiating a new game simulation runs the game and shows play-by-play updates',
    run: async ({ base, must }) => {
      const a = await makeTeam(base, 'Check Oaks', 'balanced', [{ name: 'A1', battingOrder: 1, rating: 60 }, { name: 'A2', battingOrder: 2, rating: 60 }]);
      const b = await makeTeam(base, 'Check Pines', 'balanced', [{ name: 'B1', battingOrder: 1, rating: 60 }, { name: 'B2', battingOrder: 2, rating: 60 }]);
      const created = await jsonPost(base, '/Game', { home: String(a.id), away: String(b.id), innings: '3' });
      must(created.status === 200 && created.body.ok, `game creation failed: ${JSON.stringify(created.body)}`);
      const game = created.body.row;
      must(game.status === 'finished', `the game did not simulate immediately: ${JSON.stringify(game)}`);
      const lineup = (roster) => roster.map((p) => ({ id: p.id, name: p.name, rating: p.rating }));
      const expected = simulateGame(game.id, lineup(a.roster), lineup(b.roster), 'balanced', 'balanced', 3);
      must(game.homeScore === expected.homeScore && game.awayScore === expected.awayScore,
        `score ${game.homeScore}-${game.awayScore} does not match the seeded simulation's own prediction ${expected.homeScore}-${expected.awayScore}`);
      const plays = (await jsonGet(base, `/Play?game=${game.id}`)).body.rows.sort((x, y) => x.seq - y.seq);
      must(plays.length === expected.log.length, `expected ${expected.log.length} play-by-play rows, got ${plays.length}`);
      must(plays.every((p, i) => p.description === expected.log[i].description), 'play-by-play descriptions do not match the predicted sequence');
      const html = await (await fetch(`${base}/Game/${game.id}`)).text();
      must(/Play-by-play/.test(html) && new RegExp(plays[0].description.replace(/[().]/g, '\\$&')).test(html), 'the game page does not show the play-by-play log');
      return `Game #${game.id}: ${plays.length} plays simulated deterministically, final score ${game.homeScore}-${game.awayScore} matches the seeded engine exactly, play-by-play visible`;
    } },

  { task: 'Adjusting a team\'s defense strategy is saved and changes how future simulations play out',
    run: async ({ base, must }) => {
      const batter = { name: 'Slugger', battingOrder: 1, rating: 80 };
      const away = await makeTeam(base, 'Neutral Nine', 'balanced', [{ name: 'N1', battingOrder: 1, rating: 50 }]);
      const home = await makeTeam(base, 'Strategy Sox', 'balanced', [batter]);
      const setStrategy = await jsonPost(base, `/Team/${home.id}`, { name: 'Strategy Sox', budget: '50000', trainingBudget: '10000', defenseStrategy: 'aggressive' });
      must(setStrategy.status === 200 && setStrategy.body.ok && setStrategy.body.row.defenseStrategy === 'aggressive', `defense strategy was not saved: ${JSON.stringify(setStrategy.body)}`);
      // Each side's OWN defenseStrategy governs its OWN fielding (i.e. how
      // the other team's batters fare against it) — home's newly-set
      // "aggressive" strategy is recorded as homeDefenseUsed and shapes how
      // away's batters do while home is in the field.
      const game = await jsonPost(base, '/Game', { home: String(home.id), away: String(away.id), innings: '5' });
      const lineup = (roster) => roster.map((p) => ({ id: p.id, name: p.name, rating: p.rating }));
      const expected = simulateGame(game.body.row.id, lineup(home.roster), lineup(away.roster), 'aggressive', 'balanced', 5);
      must(game.body.row.homeDefenseUsed === 'aggressive', `the game did not record the updated (aggressive) defense strategy: ${JSON.stringify(game.body.row)}`);
      must(game.body.row.homeScore === expected.homeScore && game.body.row.awayScore === expected.awayScore,
        `simulated score does not reflect the aggressive defense setting: ${game.body.row.homeScore}-${game.body.row.awayScore} vs expected ${expected.homeScore}-${expected.awayScore}`);
      const conservativeRun = simulateGame(game.body.row.id, lineup(home.roster), lineup(away.roster), 'conservative', 'balanced', 5);
      must(conservativeRun.awayScore !== expected.awayScore || conservativeRun.homeScore !== expected.homeScore,
        'changing the defense strategy has no effect at all on the simulated outcome');
      return `Team #${home.id}'s defense strategy saved as "aggressive" and used by the very next simulation (would have scored differently under "conservative")`;
    } },

  { task: 'Adjusting the training budget allocation is saved and reflected in the financial summary',
    run: async ({ base, must }) => {
      const team = await jsonPost(base, '/Team', { name: 'Budget Bears', budget: '50000', trainingBudget: '10000', defenseStrategy: 'balanced' });
      const id = team.body.id;
      const moved = await jsonPost(base, `/Team/${id}`, { name: 'Budget Bears', budget: '45000', trainingBudget: '15000', defenseStrategy: 'balanced' });
      must(moved.status === 200 && moved.body.ok, `budget update failed: ${JSON.stringify(moved.body)}`);
      must(moved.body.row.budget === 45000 && moved.body.row.trainingBudget === 15000, `budget figures were not saved: ${JSON.stringify(moved.body.row)}`);
      const html = await (await fetch(`${base}/Team/${id}`)).text();
      must(/45000/.test(html) && /15000/.test(html), 'the updated budget figures are not shown on the team page');
      const tooMuch = await jsonPost(base, `/Team/${id}`, { name: 'Budget Bears', budget: '-1', trainingBudget: '60001', defenseStrategy: 'balanced' });
      must(tooMuch.status === 400, `a negative budget was accepted: ${tooMuch.status}`);
      return `Team #${id}: training budget moved from 10000 to 15000 (main budget 50000 to 45000), shown on the team page; a negative budget is refused`;
    } },

  // navCheck walks every top-level menu item (Teams/Player Statistics/Game
  // Simulation/Standings) and confirms each loads — "Teams" is also this
  // app's home page (home: "/Team"), so returning to it from any section is
  // exactly clicking the first nav link, which this already exercises.
  navCheck(3),

  colorCheck('floralwhite', 'darkgoldenrod'),
];
