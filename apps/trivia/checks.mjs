// WebGen-Bench 000008 — online trivia contest.
import { colorCheck } from '../../verify/lib.mjs';

const num = (html, title) => {
  const m = new RegExp(`<b>([\\d.]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};

export const checks = [
  { task: 'Enroll in the first contest and see a confirmation',
    run: async ({ follow, must }) => {
      const after = await follow('/Contest/1/add/Enrollment', { player: 'Nina' });
      must(after.html.includes('You are enrolled in this contest'), 'no enrollment confirmation');
      must(after.html.includes('Nina'), 'the enrollment is not recorded under the contest');
      return 'enrolled with a confirmation';
    } },
  { task: 'Start the contest and see the first question with its options',
    run: async ({ get, must }) => {
      const { html } = await get('/Contest/1');
      must(html.includes('What is the capital of France?'), 'the first question is not shown');
      must(html.includes('Paris / Rome / Madrid'), 'the answer options are not shown');
      must(!html.includes('<td>Paris</td>'), 'the correct answer leaked into the question list');
      return 'question and options shown, answer hidden';
    } },
  { task: 'Submit an answer and get an acknowledgement',
    run: async ({ follow, must }) => {
      const after = await follow('/Answer', { question: '1', player: 'Nina', choice: 'Paris' });
      must(after.html.includes('Answer submitted'), 'no acknowledgement after submitting');
      return 'answer accepted with a confirmation';
    } },
  { task: 'The score is graded and displayed after answering',
    run: async ({ follow, get, rowWith, must }) => {
      await follow('/Answer', { question: '2', player: 'Nina', choice: '5' });
      const { html } = await get('/Answer');
      const right = rowWith(html, 'Paris');
      const wrong = rowWith(html, '<td>5</td>');
      must(right && right.includes('Correct'), 'a correct answer was not graded as correct');
      must(wrong && wrong.includes('Wrong'), 'a wrong answer was not graded as wrong');
      const board = await get('/dashboard/leaderboard');
      must(num(board.html, 'Correct answers') === 1, 'the score does not match the graded answers');
      return 'right answer scored 1, wrong answer scored 0';
    } },
  { task: 'The leaderboard shows the ranking of participants',
    run: async ({ follow, get, must }) => {
      await follow('/Answer', { question: '3', player: 'Omar', choice: 'Nile' });
      await follow('/Answer', { question: '1', player: 'Omar', choice: 'Paris' });
      const { html } = await get('/dashboard/leaderboard');
      const table = html.split('<h3>Ranking</h3>')[1];
      const order = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
      must(order.length === 2, `expected two players on the board, got ${order.length}`);
      must(order[0].includes('Omar'), 'the leaderboard is not sorted by score');
      must(/<td>2<\/td>/.test(order[0]) && /<td>1<\/td>/.test(order[1]), 'scores on the board are wrong');
      return 'two players ranked by score, Omar 2 : Nina 1';
    } },
  colorCheck('beige', 'saddlebrown'),
];
