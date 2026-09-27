// webgen-bench/000056 — data-science learning platform: browse, detail, enroll, learn, submit, grades.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the course browsing section',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const { html, status } = await get('/Course');
      must(status === 200, `course list returned ${status}`);
      must(rows(html).length === 3, `expected 3 courses, got ${rows(html).length}`);
      const row = rowWith(html, 'Python for Data Analysis');
      must(row && /Learn pandas and NumPy/.test(row) && /Dr\. Elena Cruz/.test(row), `course row: ${row}`);
      const advanced = await get('/Course?level=advanced');
      must(rows(advanced.html).length === 1 && rowWith(advanced.html, 'Deep Learning Foundations'), 'the level filter does not narrow');
      return '3 Python data-science courses listed with title, description and instructor; level filter narrows';
    } },
  { task: 'Select a specific Python data science course to view more details',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      const { html, status } = await get('/Course/1');
      must(status === 200, `course detail returned ${status}`);
      must(/<th>Syllabus<\/th><td>Week 1: NumPy arrays/.test(html), 'the syllabus is not shown');
      must(/<th>Instructor<\/th><td>Dr\. Elena Cruz<\/td>/.test(html), 'the instructor is not shown');
      must(!/action\/enroll/.test(html), 'a guest is offered to enroll before signing in');
      return 'course detail shows syllabus and instructor; enrollment is gated behind sign-in';
    } },
  { task: 'Enroll in a Python data science course',
    run: async ({ post, get, follow, rows, rowWith, must, flashOf }) => {
      const reg = await post('/register', { email: 'maria@datasci.test', password: 'maria123', name: 'Maria Gomez' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const detail = await get('/Course/1');
      must(/action\/enroll/.test(detail.html), 'a signed-in student is not offered to enroll');
      const r = await follow('/Course/1/action/enroll', {});
      must(/Enrolled in Python for Data Analysis — it now appears in your My Courses list/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.length === 1 && rowWith(r.html, 'Python for Data Analysis'), `My Courses after enrolling: ${mine.map((x) => x.slice(0, 120))}`);
      return "Maria enrolled in Python for Data Analysis; it appears in My Courses";
    } },
  { task: 'Access and start learning a course module',
    run: async ({ get, must }) => {
      const detail = await get('/Course/1');
      must(/NumPy arrays/.test(detail.html) && /pandas DataFrames/.test(detail.html), `modules not listed on the course page: ${detail.html.slice(0, 400)}`);
      const mod = await get('/Module/1');
      must(mod.status === 200, `module page returned ${mod.status}`);
      must(/NumPy arrays are the foundation of numeric Python/.test(mod.html), 'the module text content is missing');
      must(/<th>Video Url<\/th><td>https:\/\/videos\.datasci\.test\/numpy-arrays<\/td>/.test(mod.html), 'the module video link is missing');
      must(/Array practice/.test(mod.html), 'the module does not list its assignment');
      return 'module page loads with its text content, its video link and its assignment';
    } },
  { task: 'Submit an assignment for a course module',
    run: async ({ get, follow, rowWith, must, flashOf }) => {
      const before = await get('/Assignment/1');
      must(/Create a 3x3 NumPy array/.test(before.html), 'assignment instructions are missing');
      const r = await follow('/Assignment/1/add/Submission', { content: 'import numpy as np\na = np.arange(1, 10).reshape(3, 3)\na.sum(axis=1)' });
      must(/Assignment submitted — check Submissions for its status/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const submitted = rowWith(r.html, 'np.arange');
      must(submitted && /maria@datasci\.test/.test(submitted), `submission not reflected under the assignment: ${submitted}`);
      const mine = await get('/Submission');
      must(rowWith(mine.html, 'np.arange'), 'the submission is not in My Submissions');
      return "Maria's submission is reflected under the assignment and in My Submissions, ungraded so far";
    } },
  { task: 'Query grades for the completed assignments in a course',
    run: async ({ asGuest, login, get, post, rowWith, idOf, must, flashOf }) => {
      asGuest();
      must((await login('admin@datasci.test', 'admin123')).status === 303, 'admin could not log in');
      const list = await get('/Submission');
      const subId = idOf(list.html, 'np.arange', 'Submission');
      const graded = await post(`/Submission/${subId}`, { score: 90, feedback: 'Correct shape and axis; nice use of arange.' });
      must(graded.status === 303, `grading the submission returned ${graded.status}: ${graded.html.slice(0, 200)}`);
      const after = await get(graded.location);
      must(/Grade saved/.test(flashOf(after.html)), `flash: ${flashOf(after.html)}`);
      asGuest();
      must((await login('maria@datasci.test', 'maria123')).status === 303, 'maria could not sign back in');
      const mine = await get('/Submission');
      const row = rowWith(mine.html, 'np.arange');
      must(row && /<td>90<\/td><td>90<\/td>/.test(row), `graded row does not show score and percent: ${row}`);
      return 'the graded submission shows a score of 90 and a percentage of 90% in My Submissions';
    } },
  colorCheck('honeydew', 'darkolivegreen'),
];
