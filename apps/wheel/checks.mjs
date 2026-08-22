// WebGen-Bench 000010 — wheel of fortune.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Spin the wheel; it stops on a segment and shows the prize won',
    run: async ({ follow, flashOf, must }) => {
      const after = await follow('/action/spin', {});
      const flash = flashOf(after.html);
      must(/The wheel stopped — you won: .+/.test(flash), `no prize announced, flash was "${flash}"`);
      const prize = /you won: (.+)$/.exec(flash)[1];
      must(prize.trim().length > 0, 'the prize name is empty');
      return `stopped on "${prize}"`;
    } },
  { task: 'The prize list is complete and matches the wheel',
    run: async ({ get, rows, must }) => {
      const { html } = await get('/Prize');
      const listed = rows(html);
      must(listed.length === 4, `expected 4 prizes, page shows ${listed.length}`);
      for (const name of ['Coffee mug', 'Gift card', 'Headphones', 'Try again'])
        must(html.includes(name), `prize "${name}" is missing from the list`);
      return 'all four prizes listed with their weights';
    } },
  { task: 'The winning record is updated with the latest prize and its date',
    run: async ({ follow, get, flashOf, rows, must }) => {
      const before = rows((await get('/list/my-wins')).html).length;
      const after = await follow('/action/spin', {});
      const prize = /you won: (.+)$/.exec(flashOf(after.html))[1].trim();
      const { html } = await get('/list/my-wins');
      const listed = rows(html);
      must(listed.length === before + 1, `expected one new record, got ${listed.length - before}`);
      must(listed[0].includes(prize), `the newest record does not name the prize just won ("${prize}")`);
      must(/\d{4}-\d{2}-\d{2}T/.test(listed[0]), 'the record has no date');
      return `record added for "${prize}" with a timestamp`;
    } },
  colorCheck('lightgray', 'darkred'),
];
