// WebGen-Bench 000050 — women's health survey.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Reach the survey page from the homepage',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.html.includes('href="/Response/new"'), 'homepage has no link to the survey');
      const form = await get('/Response/new');
      must(form.status === 200 && /Women&#39;s health survey/.test(form.html), 'survey page did not load');
      must(/Symptoms/.test(form.html), 'survey form is missing its health fields');
      return 'homepage link opens the survey form';
    } },
  { task: 'Fill out and submit the survey; a confirmation is shown',
    run: async ({ follow, must }) => {
      const after = await follow('/Response', { name: 'Participant A', age: '34', height: '167', weight: '61',
        symptoms: 'Occasional headaches', consent: 'on' });
      must(after.html.includes('Thank you'), 'no confirmation after submitting');
      must(after.html.includes('Participant A'), 'submission is not stored');
      return 'submitted with a thank-you confirmation';
    } },
  { task: 'Form validation reports incomplete or badly formatted entries',
    run: async ({ post, get, must, base }) => {
      const r = await fetch(base + '/Response', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: '', age: 'abc', symptoms: '' }).toString() });
      const html = await r.text();
      must(r.status === 400, `expected the submission to be refused, got ${r.status}`);
      must(/name is required/.test(html), 'missing name was accepted');
      must(/symptoms is required/.test(html), 'missing symptoms was accepted');
      must(/age must be a number/.test(html), 'a non-numeric age was accepted');
      const list = await get('/Response');
      must(!list.html.includes('abc'), 'the rejected submission still reached the data');
      return 'three field errors shown, nothing stored';
    } },
  { task: 'Submitted information is available in the data management section',
    run: async ({ get, rowWith, must }) => {
      const { html } = await get('/Response');
      must(rowWith(html, 'Participant A'), 'submission is missing from data management');
      must(/<th>Age<\/th>/.test(html) && /<th>Consent<\/th>/.test(html), 'data table lacks the survey fields');
      return 'submissions listed with their fields';
    } },
  { task: 'The report reflects the submitted data accurately',
    run: async ({ follow, get, must }) => {
      await follow('/Response', { name: 'Participant B', age: '46', height: '160', weight: '70',
        symptoms: 'None', consent: '' });
      const { html } = await get('/dashboard/report');
      const num = (title) => {
        const m = new RegExp(`<b>([\\d.]+)</b>${title}`).exec(html);
        if (!m) throw new Error(`metric "${title}" is missing`);
        return Number(m[1]);
      };
      must(num('Responses') === 2, `expected 2 responses, report says ${num('Responses')}`);
      must(Math.abs(num('Average age') - 40) < 0.01, `average age should be 40, report says ${num('Average age')}`);
      must(num('Consent given') === 1, 'consent counter does not match the data');
      return 'count, averages and breakdown match the submissions';
    } },
  colorCheck('whitesmoke', 'darkcyan'),
];
