// WebGen-Bench 000062 — DMV practice tests: browse the bank, pick questions,
// take a simulated exam, get scored and see which answers were wrong.
import { colorCheck } from '../../verify/lib.mjs';

let examId = null;

export const checks = [
  { task: 'Check the accessibility of the practice question bank',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/Question');
      must(r.status === 200, `question bank returned ${r.status}`);
      must(rows(r.html).length === 5, `expected 5 seeded questions, got ${rows(r.html).length}`);
      return '5 questions listed, no sign-in needed';
    } },
  { task: 'Test the question selection process from the practice question bank',
    run: async ({ login, get, idOf, follow, flashOf, rows, must }) => {
      must((await login('sam@dmv.test', 'sam123')).status === 303, 'sam could not sign in');
      const bank = await get('/Question');
      const q = idOf(bank.html, 'octagonal', 'Question');
      const picked = await follow(`/Question/${q}/action/select`, {});
      must(/Selected for practice/.test(flashOf(picked.html)), `selection not confirmed: ${flashOf(picked.html)}`);
      const practice = await get('/list/my-practice');
      must(rows(practice.html).length === 1 && /octagonal/.test(practice.html), 'the picked question is not in "My practice set"');
      return 'the octagon question is picked and shown in "My practice set"';
    } },
  { task: 'Validate the functionality of the simulated exam feature',
    run: async ({ follow, must, flashOf }) => {
      const started = await follow('/Exam', {});
      examId = /Exam #(\d+)/.exec(started.html)?.[1];
      must(examId, `exam did not start: ${flashOf(started.html)}`);
      must(/<th>Questions<\/th><td>5<\/td>/.test(started.html), 'the exam does not cover the whole bank');
      // Answer every question (one wrong on purpose, to feed the error analysis check).
      const answers = [[1, 'A'], [2, 'A'], [3, 'C'], [4, 'A'], [5, 'B']];
      let last;
      for (const [question, choice] of answers) last = await follow(`/Exam/${examId}/add/Answer`, { question, choice });
      must(/<th>Answered<\/th><td>5<\/td>/.test(last.html), `not every question was answered: ${last.html.match(/<th>Answered<\/th><td>\d+<\/td>/)}`);
      const submitted = await follow(`/Exam/${examId}/go/submit`, {});
      must(/Exam submitted/.test(flashOf(submitted.html)), `exam did not conclude: ${flashOf(submitted.html)}`);
      must(/status">Submitted/.test(submitted.html), 'the exam is not marked submitted');
      return `exam #${examId}: 5 questions answered, submitted`;
    } },
  { task: "Ensure the error analysis feature's availability post-exam",
    run: async ({ get, rows, must }) => {
      const r = await get('/list/my-errors');
      must(r.status === 200, `error analysis returned ${r.status}`);
      const found = rows(r.html);
      must(found.length === 1 && /triangular/.test(found[0]), `expected the one wrong answer, got: ${found.map((x) => x.slice(0, 60))}`);
      must(/<td>B<\/td>/.test(found[0]) && /YIELD/.test(found[0]), 'the expected letter and explanation are not both shown');
      return 'the one wrong answer is listed with the expected letter (B) and its explanation';
    } },
  { task: 'Assess the display of exam scores',
    run: async ({ get, must }) => {
      const r = await get(`/Exam/${examId}`);
      must(/<th>Score<\/th><td>80<\/td>/.test(r.html), `score is not 80: ${r.html.match(/<th>Score<\/th><td>\d+<\/td>/)}`);
      must(/<th>Correct<\/th><td>4<\/td>/.test(r.html) && /<th>Wrong<\/th><td>1<\/td>/.test(r.html), 'correct/wrong counts do not match the answers');
      return 'exam #' + examId + ' shows 80% (4 correct, 1 wrong), matching what was answered';
    } },
  { task: "Verify the website's navigation flow",
    run: async ({ get, must }) => {
      for (const p of ['/Question', '/Exam', '/Answer', '/list/my-practice', '/list/my-errors']) {
        const r = await get(p);
        must(r.status === 200, `${p} returned ${r.status}`);
      }
      return 'question bank, exams, answers, practice set and error analysis all load for a signed-in student';
    } },
  colorCheck('floralwhite', 'darkgoldenrod'),
];
