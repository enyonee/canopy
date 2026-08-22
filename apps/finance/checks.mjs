// WebGen-Bench 000003 — multi-company financial dashboard.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const num = (html, title) => {
  const m = new RegExp(`<b>([\\d.\\-]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};
const cells = (html, tableTitle, rowText) => {
  const table = html.split(`<h3>${tableTitle}</h3>`)[1];
  if (!table) throw new Error(`table "${tableTitle}" is missing`);
  const row = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).find((r) => r.includes(rowText));
  if (!row) throw new Error(`row "${rowText}" is missing from "${tableTitle}"`);
  return [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
};

export const checks = [
  { task: "Access the first company's financial data from the dashboard",
    run: async ({ get, rows, must }) => {
      const { html } = await get('/Report?company=1');
      const listed = rows(html);
      must(listed.length === 2, `expected 2 periods for the first company, got ${listed.length}`);
      must(listed.every((r) => r.includes('Northwind')), 'rows of another company leaked in');
      must(listed[0].includes('1200') || listed[1].includes('1200'), 'the reported revenue does not match the source data');
      return "only the first company's periods, values intact";
    } },
  { task: 'Generate a consolidated report across companies with a summary',
    run: async ({ get, must }) => {
      const { html } = await get('/dashboard/consolidated');
      must(num(html, 'Companies') === 3, 'company count is wrong');
      must(num(html, 'Total revenue') === 8950, `total revenue should be 8950, dashboard says ${num(html, 'Total revenue')}`);
      must(num(html, 'Total profit') === 1680, `total profit should be 1680, dashboard says ${num(html, 'Total profit')}`);
      const marisol = cells(html, 'Revenue, expenses and profit by company', 'Marisol');
      must(marisol[1] === '4500', `Marisol revenue should be 4500, table says ${marisol[1]}`);
      return 'totals and per-company breakdown match the source rows';
    } },
  { task: 'Compare metrics of the second and third companies side by side',
    run: async ({ get, must }) => {
      const { html } = await get('/dashboard/comparison');
      const helio = cells(html, 'Metrics per company', 'Helio');
      const marisol = cells(html, 'Metrics per company', 'Marisol');
      must(Math.abs(Number(helio[1]) - 875) < 0.01, `Helio average revenue should be 875, got ${helio[1]}`);
      must(Math.abs(Number(marisol[1]) - 2250) < 0.01, `Marisol average revenue should be 2250, got ${marisol[1]}`);
      must(Number(helio[2]) === 230 && Number(marisol[2]) === 350, 'best profit per company is wrong');
      must(helio[3] === '2' && marisol[3] === '2', 'period counts are wrong');
      return 'both companies in one table, averages and maxima correct';
    } },
  navCheck(4),
  colorCheck('mintcream', 'teal'),
];
