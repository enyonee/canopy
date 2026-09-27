// WebGen-Bench 000078 — a computing-task site: input an expression, pick a
// calculation type, execute it, see the result; invalid input is refused.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Input a basic mathematical expression (e.g., "2 + 2") into the expression input field',
    run: async ({ get, follow, must }) => {
      const form = await get('/Calculation/new');
      must(/name="expression"/.test(form.html) && /name="kind"/.test(form.html), 'no expression field on the form');
      const r = await follow('/Calculation', { expression: '2 + 2', kind: 'basic', note: '' });
      must(/<h2>2 \+ 2<\/h2>/.test(r.html) && /<th>Expression<\/th><td>2 \+ 2<\/td>/.test(r.html),
        `expression was not kept verbatim: ${r.html.slice(0, 300)}`);
      return '"2 + 2" is displayed back exactly as typed, with no modification';
    } },
  { task: 'Select a calculation type from the available options (e.g., "Basic Arithmetic")',
    run: async ({ follow, must }) => {
      const r = await follow('/Calculation', { expression: '2 ^ 8', kind: 'scientific', note: '' });
      must(/<th>Kind<\/th><td>scientific<\/td>/.test(r.html), `kind not confirmed on the detail page: ${r.html.slice(0, 200)}`);
      return 'kind "scientific" is shown on the calculation it was chosen for';
    } },
  { task: 'Click the button to execute the calculation after entering a mathematical expression and selecting a calculation type',
    run: async ({ follow, must, flashOf }) => {
      const r = await follow('/Calculation', { expression: '(1 + 2) * 3', kind: 'basic', note: '' });
      must(/Calculated/.test(flashOf(r.html)), `no confirmation flash: ${flashOf(r.html)}`);
      must(/<th>Result<\/th><td>9<\/td>/.test(r.html), `result not shown: ${r.html.slice(0, 300)}`);
      return '(1 + 2) * 3 executes to a result of 9, shown on the results screen';
    } },
  { task: 'Input an invalid mathematical expression (e.g., "2 ++ 2") and attempt to execute the calculation',
    run: async ({ post, must }) => {
      const r = await post('/Calculation', { expression: '2 ++ 2', kind: 'basic', note: '' });
      must(r.status === 400, `invalid expression was accepted (status ${r.status})`);
      must(/Invalid expression: use numbers/.test(r.html), `no guiding error message: ${r.html.slice(0, 300)}`);
      must(/value="2 \+\+ 2"/.test(r.html), 'the invalid expression is not kept in the field for correction');
      return 'invalid expression 400s with a message that names valid syntax; the input is kept';
    } },
  { task: "Test the website's navigation by moving from the home page to the calculation page",
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.status === 200, `home did not render: ${home.status}`);
      must(/href="\/Calculation\/new"/.test(home.html), 'home has no link to the calculator');
      const calc = await get('/Calculation/new');
      must(calc.status === 200 && /Calculator/.test(calc.html), `calculation page did not load: ${calc.status}`);
      const history = await get((/href="(\/Calculation)"/.exec(home.html) || [, '/Calculation'])[1]);
      must(history.status === 200, `history page did not load: ${history.status}`);
      return 'home → calculator and home → history both load cleanly';
    } },
  colorCheck('mintcream', 'teal'),
];
