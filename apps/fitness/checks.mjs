// webgen-bench/000076 — fitness tracker: leaderboard, exercises, diary, personal stats.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the fitness leaderboard page',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const board = await get('/dashboard/leaderboard');
      must(board.status === 200, `leaderboard returned ${board.status}`);
      must(/<td>kai@fitness\.test<\/td><td>75<\/td><td>2<\/td>/.test(board.html), `Kai's ranking row is wrong: ${board.html.slice(0, 900)}`);
      must(/<td>leah@fitness\.test<\/td><td>20<\/td><td>1<\/td>/.test(board.html), `Leah's ranking row is wrong: ${board.html.slice(0, 900)}`);
      must(board.html.indexOf('kai@fitness.test') < board.html.indexOf('leah@fitness.test'), 'the leaderboard is not ranked by total minutes');
      const away = await get('/Exercise');
      must(away.status === 200, `navigating away to the activity feed returned ${away.status}`);
      return 'leaderboard ranks kai@fitness.test (75 min, 2 sessions) above leah@fitness.test (20 min, 1 session); navigating away works';
    } },
  { task: 'Record a new exercise activity',
    run: async ({ post, follow, get, login, idOf, rows, rowWith, must, flashOf }) => {
      const reg = await post('/register', { email: 'sam@fitness.test', password: 'sam123', name: 'Sam Ortiz' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const r = await follow('/Exercise', { type: 'running', durationMinutes: 25, calories: 220, date: '2026-09-25', notes: 'Morning jog' });
      must(/Exercise recorded/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.length === 1, `expected exactly 1 exercise under My Exercises, got ${mine.length}`);
      must(/running/.test(mine[0]) && /<td>25<\/td>/.test(mine[0]) && /<td>220<\/td>/.test(mine[0]), `recorded exercise row: ${mine[0]}`);
      // Round 4: `own` grew `all`, so Sam may now edit/delete this exercise (the public feed
      // stays unscoped for everyone), but Kai (another user, seeded with exercises of their own)
      // may not touch it.
      const feed = await get('/Exercise');
      const exId = idOf(feed.html, 'sam@fitness.test', 'Exercise');
      must(exId, 'could not find the recorded exercise\'s id in the public feed');
      const editedBySam = await post(`/Exercise/${exId}`, { type: 'running', durationMinutes: 25, calories: 220, date: '2026-09-25', notes: 'Morning jog (edited)' });
      must(editedBySam.status === 303, `Sam could not edit their own exercise: ${editedBySam.status}`);
      await login('kai@fitness.test', 'kai123');
      must((await post(`/Exercise/${exId}`, { type: 'running', durationMinutes: 1, calories: 1, date: '2026-09-25' })).status === 403, 'Kai could edit Sam\'s exercise');
      await login('sam@fitness.test', 'sam123');
      return 'a 25-minute run recorded and shown under My Exercises without discrepancies; only Sam may edit it';
    } },
  { task: 'Write and save a new entry in the fitness diary',
    run: async ({ follow, rows, must, flashOf }) => {
      const r = await follow('/DiaryEntry', { title: 'Feeling strong today', body: 'Finished a 25 minute run and felt great.', mood: 'great', date: '2026-09-25' });
      must(/Diary entry saved/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.length === 1 && /Feeling strong today/.test(mine[0]) && /great/.test(mine[0]), `diary row: ${mine[0]}`);
      return 'diary entry saved and retrievable from My Fitness Diary';
    } },
  { task: 'View personal fitness statistics on the homepage',
    run: async ({ get, must }) => {
      const home = await get('/');
      must(home.status === 200 && /My Fitness Stats/.test(home.html), `home page is not the personal stats dashboard: ${home.status}`);
      must(/<b>1<\/b>Exercises logged/.test(home.html), `exercise count card wrong: ${home.html.slice(0, 900)}`);
      must(/<b>25<\/b>Total minutes/.test(home.html), `total minutes card wrong: ${home.html.slice(0, 900)}`);
      must(/<b>220<\/b>Total calories/.test(home.html), `total calories card wrong: ${home.html.slice(0, 900)}`);
      must(/<b>1<\/b>Diary entries/.test(home.html), `diary entry count card wrong: ${home.html.slice(0, 900)}`);
      return 'homepage shows an accurate summary: 1 exercise, 25 minutes, 220 calories, 1 diary entry';
    } },
  colorCheck('white', 'navy'),
];
