// webgen-bench/000060 — WordWise vocabulary learning site: WordSet/Word rows,
// a single global grading action (submitQuiz) behind plugins/vocab.mjs's
// vocab.grade block, and two widgets (vocabquiz, waitroom).
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';

const jsonGet = async (base, path) => { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json() }; };

export const checks = [
  { task: 'Navigate to each of the 5 activity pages and verify that each page correctly begins an activity (crossword puzzle, unjumble letters, etc.)',
    run: async ({ get, must }) => {
      const pages = [
        ['quiz-matching', 'Synonyms &amp; Antonyms', 'data-widget="vocabquiz"'],
        ['quiz-fillblank', 'Fill in the Blank', 'data-widget="vocabquiz"'],
        ['quiz-unjumble', 'Unjumble the Letters', 'data-widget="vocabquiz"'],
        ['quiz-crossword', 'Mini Crossword', 'data-widget="vocabquiz"'],
        ['quiz-flashcard', 'Flashcards', 'data-widget="vocabquiz"'],
      ];
      for (const [id, heading, marker] of pages) {
        const r = await get(`/page/${id}`);
        must(r.status === 200, `/page/${id} returned ${r.status}`);
        must(r.html.includes(heading), `/page/${id} does not show the "${heading}" heading`);
        const kind = id.replace('quiz-', '');
        must(r.html.includes(marker) && new RegExp(`kind&quot;:&quot;${kind}&quot;`).test(r.html), `/page/${id} does not embed a vocabquiz widget with kind=${kind}`);
      }
      return '5 distinct activity pages, each embedding its own kind of vocabquiz widget';
    } },
  { task: 'On the dashboard, verify that the progress summary updates after completing a word game',
    run: async ({ base, must }) => {
      const before = await jsonGet(base, '/dashboard/progress');
      const beforeCount = before.body.cards.find((c) => c.title === 'Quiz Attempts').value;
      const words = (await jsonGet(base, '/Word?wordSet=2')).body.rows;
      const b = await openBrowser(`${base}/page/quiz-fillblank`);
      try {
        await b.until(`document.querySelectorAll('[data-qword]').length === ${words.length}`);
        const order = await b.eval(`[...document.querySelectorAll('[data-qword]')].map((g) => g.dataset.qword)`);
        must(order.every((id, i) => Number(id) === words[i].id), 'the widget did not render words in the order the server returned them');
        for (const w of words) {
          await b.eval(`(() => { const i = document.querySelector('[data-qword="${w.id}"] [data-field="value"]'); i.value = ${JSON.stringify(w.term)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        }
        await b.eval(`document.querySelector('[data-quiz-form] button[type="submit"]').click()`);
        await b.until(`document.querySelector('[data-result]').textContent.startsWith('Scored')`);
        const result = await b.eval(`document.querySelector('[data-result]').textContent`);
        must(result === `Scored ${words.length}/${words.length}`, `expected a perfect score, got "${result}"`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const after = await jsonGet(base, '/dashboard/progress');
      const afterCount = after.body.cards.find((c) => c.title === 'Quiz Attempts').value;
      must(afterCount === beforeCount + 1, `dashboard attempt count did not increase: ${beforeCount} -> ${afterCount}`);
      const avgPct = after.body.cards.find((c) => c.title === 'Average Score %').value;
      must(Number(avgPct) > 0, `average score % did not update: ${avgPct}`);
      return `typed all ${words.length} answers into the real fill-in-the-blank widget for a perfect score; dashboard attempt count ${beforeCount} -> ${afterCount} and average score % updated`;
    } },
  { task: "Access the weekly new words section and verify the display of exactly 10 new words",
    run: async ({ get, rows, must }) => {
      const list = await get('/WordSet');
      must(list.status === 200, `/WordSet returned ${list.status}`);
      const latestRow = rows(list.html).find((r) => />2</.test(r) || /Week 2/.test(r));
      must(latestRow, `could not find the current (week 2) word set in the list: ${list.html.slice(0, 400)}`);
      const detail = await get('/WordSet/2');
      must(detail.status === 200 && /Week 2: Precision/.test(detail.html), 'week 2\'s detail page did not open');
      const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(detail.html);
      must(tbody, 'the related "words" table is missing from the word set detail page');
      const wordRows = [...tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
      must(wordRows.length === 10, `expected exactly 10 new words for the current week, got ${wordRows.length}`);
      return 'word set #2 (the current week) shows exactly 10 words in its related table';
    } },
  { task: 'Validate the functionality of selecting and setting an avatar in the waiting room',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/page/waiting-room`);
      try {
        await b.until(`document.querySelector('[data-current]')`);
        const before = await b.eval(`document.querySelector('[data-current] b').textContent`);
        must(before === 'fox', `expected the default avatar "fox", got "${before}"`);
        await b.eval(`document.querySelector('[data-avatar="owl"]').click()`);
        await b.until(`document.querySelector('[data-current] b').textContent === 'owl'`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
        await b.goto(`${base}/page/waiting-room`); // a fresh page load, standing in for a session reload
        await b.until(`document.querySelector('[data-current] b').textContent === 'owl'`);
      } finally { await b.close(); }
      const profile = await jsonGet(base, '/Profile/1');
      must(profile.body.avatar === 'owl', `the avatar was not persisted server-side: ${JSON.stringify(profile.body)}`);
      return 'avatar changed fox -> owl, updated immediately on screen, and still owl after a fresh page load';
    } },
  { task: 'Test navigation from the home page to the blog and back to ensure accessibility and consistent navigation',
    run: async ({ get, must }) => {
      const home = await get('/');
      must(/href="\/BlogPost"/.test(home.html), 'the home page has no link to the blog');
      const blog = await get('/BlogPost');
      must(blog.status === 200 && /Why 10 words a week beats 100 words a day/.test(blog.html), 'the blog list is missing its posts');
      const post = await get('/BlogPost/1');
      must(post.status === 200, `a blog post detail returned ${post.status}`);
      const back = await get('/');
      must(back.status === 200 && /Learn 10 new words every week/.test(back.html), 'returning to the home page failed');
      return 'home -> blog -> a post -> back to home, every hop 200';
    } },
  { task: 'Play the simple game available in the waiting room',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/page/waiting-room`);
      try {
        await b.until(`document.querySelector('[data-click]')`);
        for (let i = 0; i < 5; i++) await b.eval(`document.querySelector('[data-click]').click()`);
        await b.until(`document.querySelector('[data-done]')`);
        must(await b.eval(`document.querySelector('[data-done]').textContent.includes('You win')`), 'the game did not announce a win');
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'five clicks end the waiting-room game with "You win!"';
    } },
  colorCheck('lightgray', 'darkred'),
];
