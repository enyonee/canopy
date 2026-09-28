// webgen-bench/000033 — a Q&A site: questions, answers under them, ratings; one check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let questionId = null, answerId = null;
const TITLE = 'Why is the sky blue?';
const answerIdIn = (row) => { const m = /\/Answer\/(\d+)\/action\/upvote/.exec(row || ''); return m ? m[1] : null; };

export const checks = [
  { task: 'Submit a new question using the question submission form',
    run: async ({ asGuest, get, post, follow, login, rowWith, must, flashOf }) => {
      asGuest();
      const anon = await get('/Question/new');
      must(anon.location.startsWith('/login'), `a guest reached the question form: ${anon.status} ${anon.location}`);
      const reg = await post('/register', { email: 'eve@qna.test', password: 'eve123', name: 'Eve' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const short = await post('/Question', { title: 'Why', body: 'Too short a title' });
      must(short.status === 400 && /at least 5 characters/.test(short.html), 'a too-short title was accepted');
      const saved = await post('/Question', { title: TITLE, body: 'Sunlight scatters in the atmosphere, but why blue and not violet?' });
      must(saved.status === 303 && /^\/Question\/\d+/.test(saved.location), `posting returned ${saved.status} ${saved.location}`);
      questionId = /\/Question\/(\d+)/.exec(saved.location)[1];
      const detail = await get(saved.location);
      must(/Your question has been posted/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(new RegExp(`<th>Title</th><td>${TITLE.replace('?', '\\?')}</td>`).test(detail.html), 'the question page does not show the title');
      must(/<th>Author<\/th><td><a href="\/User\/\d+">eve@qna.test<\/a>/.test(detail.html), 'the author was not filled from the session');
      const list = await get('/Question');
      must(rowWith(list.html, TITLE), 'the new question is not in the list');
      // Round 4: `own` grew `all`, so eve may now edit/delete only her own question.
      const editedByAuthor = await post(`/Question/${questionId}`, { title: TITLE, body: 'Edited: sunlight scatters more at shorter (blue) wavelengths.' });
      must(editedByAuthor.status === 303, `eve could not edit her own question: ${editedByAuthor.status}`);
      await login('dana@qna.test', 'dana123');
      const hijack = await post(`/Question/${questionId}`, { title: 'hijacked', body: 'x' });
      must(hijack.status === 403, `dana could edit eve's question (status ${hijack.status})`);
      await login('eve@qna.test', 'eve123');
      return `posted as #${questionId}; guest redirected; short title refused; the author (only) may edit it`;
    } },
  { task: 'View the list of submitted questions',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Question');
      must(status === 200, `list returned ${status}`);
      must(/<th>(?:<a[^>]*>)?Title/.test(html) && /<th>(?:<a[^>]*>)?Answers/.test(html), 'columns are missing');
      const all = rows(html);
      must(all.length === 3, `expected 3 questions, got ${all.length}`);
      must(all[0].includes(TITLE), `the latest question is not first: ${all[0].slice(0, 120)}`);
      const center = rowWith(html, 'How do I center a div?');
      must(center && /<td>2<\/td><td>3<\/td>/.test(center), `derived answer count / best rating wrong: ${center}`);
      const asc = await get('/Question?sort=createdAt&dir=asc');
      must(rows(asc.html)[0].includes('How do I center a div?'), 'sorting by the column header does not reorder');
      return '3 questions, newest first, counts derived, header sort works';
    } },
  { task: 'Submit an answer to an existing question',
    run: async ({ post, get, rowWith, must, flashOf }) => {
      const r = await post(`/Question/${questionId}/add/Answer`, { body: 'Rayleigh scattering favours short wavelengths; our eyes are more sensitive to blue than violet.' });
      must(r.status === 303, `posting the answer returned ${r.status}: ${r.html.slice(0, 200)}`);
      const detail = await get(r.location);
      must(/Your answer has been posted/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      const row = rowWith(detail.html, 'Rayleigh scattering');
      must(row && /eve@qna.test/.test(row) && /<td>0<\/td>/.test(row), `answer row: ${row}`);
      answerId = answerIdIn(row);
      must(answerId, 'no rating buttons on the answer');
      must(/<th>Answers<\/th><td>1<\/td>/.test(detail.html), 'the answer count did not follow');
      const empty = await post(`/Question/${questionId}/add/Answer`, { body: '' });
      must(empty.status === 400 && /body is required/.test(empty.html), 'an empty answer was accepted');
      return `answer #${answerId} under question #${questionId}; empty answer refused`;
    } },
  { task: 'View answers to a specific question and rate them',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, must, flashOf }) => {
      asGuest();
      const guest = await get(`/Question/${questionId}`);
      must(guest.status === 200 && /<h3>Answers<\/h3>/.test(guest.html) && rowWith(guest.html, 'Rayleigh scattering'), 'a guest does not see the answers beneath the question');
      must(!/action\/upvote/.test(guest.html), 'a guest is offered rating buttons');
      must((await post(`/Answer/${answerId}/action/upvote`, {})).status === 403, 'a guest could rate');
      must((await login('dana@qna.test', 'dana123')).status === 303, 'dana could not log in');
      await follow(`/Question/${questionId}/add/Answer`, { body: 'Also: the sun is not blue, the scattered light is.' });
      let detail = await get(`/Question/${questionId}`);
      const answers = rows(detail.html).filter((x) => /action\/upvote/.test(x));
      must(answers.length === 2 && /<th>Answers<\/th><td>2<\/td>/.test(detail.html), `expected 2 answers under the question, got ${answers.length}`);
      let r = await follow(`/Answer/${answerId}/action/upvote`, {});
      must(/Thanks for rating/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<td>1<\/td>/.test(rowWith(r.html, 'Rayleigh scattering')), 'the rating did not go up');
      must(/<th>Best Rating<\/th><td>1<\/td>/.test(r.html), 'the best rating is not derived from the answers');
      r = await follow(`/Answer/${answerId}/action/downvote`, {});
      must(/<td>0<\/td>/.test(rowWith(r.html, 'Rayleigh scattering')), 'the rating did not go down');
      return 'answers listed beneath the question; +1/-1 rating; guests read only';
    } },
  colorCheck('beige', 'saddlebrown'),
];

export const changes = [
  { title: 'second role with reduced access', patch: 'change-1-role.patch.json', checks: [
    { task: 'A moderator reads everything, deletes an answer, but posts nothing and sees no admin surface',
      run: async ({ asGuest, login, get, post, rows, rowWith, must }) => {
        must((await login('admin@qna.test', 'admin123')).status === 303, 'admin could not log in');
        const made = await post('/User', { email: 'mo@qna.test', password: 'mo123', name: 'Mo', role: 'moderator' });
        must(made.status === 303, `creating the moderator returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        must((await login('mo@qna.test', 'mo123')).status === 303, 'the moderator could not log in');
        const list = await get('/Question');
        must(rows(list.html).length === 3 && rowWith(list.html, TITLE), 'the moderator does not see every question, or the base data is gone');
        must(!/href="\/Question\/new"/.test(list.html), 'the moderator is offered to ask a question');
        must((await get('/Question/new')).status === 403, 'the moderator opened the question form');
        must((await post('/Question', { title: 'Sneaky question', body: 'x' })).status === 403, 'the moderator posted a question');
        must((await post(`/Question/${questionId}/add/Answer`, { body: 'x' })).status === 403, 'the moderator posted an answer');
        must((await post(`/Answer/${answerId}/action/upvote`, {})).status === 403, 'the moderator rated an answer');
        let detail = await get(`/Question/${questionId}`);
        must(/<th>Answers<\/th><td>2<\/td>/.test(detail.html), 'the answers from the base run are gone');
        const del = await post(`/Answer/${answerId}/delete`, {});
        must(del.status === 303, `deleting an answer returned ${del.status}`);
        detail = await get(`/Question/${questionId}`);
        must(/<th>Answers<\/th><td>1<\/td>/.test(detail.html) && !rowWith(detail.html, 'Rayleigh scattering'), 'the answer was not removed');
        must((await get('/outbox')).status === 403, 'the moderator opened the outbox');
        const users = await get('/User');
        must(users.status === 200 && !/href="\/User\/new"/.test(users.html) && (await get('/User/new')).status === 403, 'the moderator can add users');
        return 'moderator: 3 questions visible, answer deleted, create/rate/outbox/users-new 403';
      } },
  ] },
];
