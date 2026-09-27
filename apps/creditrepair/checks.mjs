// WebGen-Bench 000014 — credit repair lead-gen site: lead form, score inquiry, service intro.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Submitting the lead form with valid personal information and credit status succeeds with a confirmation',
    run: async ({ get, follow, must, flashOf }) => {
      const before = await get('/Lead');
      must(before.status === 200 && /Submit your information/.test(before.html), 'the Apply Now page has no way to start the form');
      const r = await follow('/Lead', { name: 'Priya Shah', email: 'priya@example.test', phone: '555-0142',
        address: '10 Elm St', employmentStatus: 'employed', creditStatus: 'poor', notes: 'Two late payments last year, want to buy a house next year.' });
      must(r.status === 200, `submitting the lead form returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/recorded/.test(flashOf(r.html)), `no confirmation message: ${flashOf(r.html)}`);
      const list = await get('/Lead');
      must(/Priya Shah/.test(list.html) && /poor/.test(list.html), 'the lead was not recorded');
      return 'lead recorded; confirmation shown; visible on Apply Now';
    } },
  { task: 'The credit score inquiry accepts valid input and returns a score with feedback and next steps',
    run: async ({ follow, get, must, flashOf }) => {
      const r = await follow('/CreditInquiry', { name: 'Jordan Lee', email: 'jordan@example.test',
        paymentHistory: 'always_on_time', utilization: 0, openAccounts: 10, latePayments: 0 });
      must(r.status === 200, `submitting the inquiry returned ${r.status}: ${r.html.slice(0, 300)}`);
      must(/estimated score and next steps/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(/<th>Score<\/th><td>750<\/td>/.test(r.html), `score is not derived correctly: ${r.html.match(/<th>Score<\/th><td>[^<]*<\/td>/)}`);
      must(/<th>Band<\/th><td>Excellent<\/td>/.test(r.html), 'the band does not match the score');
      must(/<th>Advice<\/th><td>Excellent score/.test(r.html), 'no actionable advice shown');
      const bad = await get('/CreditInquiry');
      must(bad.status === 200, 'the score check page is not reachable');
      return 'score 750, band Excellent, advice shown on the result page';
    } },
  { task: 'The homepage presents clear, accurate introductory content about the credit repair services',
    run: async ({ get, must }) => {
      const { html, status } = await get('/page/home');
      must(status === 200, `homepage returned ${status}`);
      must(/Credit repair/i.test(html) && /audit/i.test(html) && /dispute/i.test(html), 'the homepage does not introduce the credit repair services clearly');
      must(/Check Your Score/.test(html) && /Apply Now/.test(html), 'the homepage does not link to the score check and application');
      return 'homepage introduces the company and its services with working links';
    } },
  { task: 'The visitor can navigate to an introduction to the credit repair services',
    run: async ({ get, must }) => {
      const { html, status } = await get('/Service');
      must(status === 200, `services page returned ${status}`);
      must(/Credit report audit/.test(html) && /Dispute filing/.test(html) && /Credit building plan/.test(html) && /Ongoing monitoring/.test(html),
        'not every credit repair service is introduced');
      must(/pull your reports from all three bureaus/.test(html), 'service descriptions are missing');
      return 'all four services listed with descriptions';
    } },
  colorCheck('oldlace', 'rosybrown'),
];
