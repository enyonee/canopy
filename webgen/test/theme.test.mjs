// The palette generated from a graph's two theme colours passes WCAG 2.2 on every pair the screens draw: text 4.5:1,
// UI parts and chart marks 3:1 (1.4.3, 1.4.11), in light and in dark. Checked for the shop, the crm and the trading
// apps and for every other app of the repository, so a new theme cannot ship an unreadable pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTheme, themeCss } from '../lib/theme.mjs';
import { parseColor, toOklch, contrast } from '../lib/color.mjs';
import { ROOT } from './helpers.mjs';

const themeOf = (app) => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'app.json'), 'utf8')).theme || {};

for (const app of ['shop', 'crm', 'trading']) {
  test(`contrast of every generated pair, ${app}`, () => {
    const t = buildTheme(themeOf(app));
    const failing = t.pairs.filter((p) => p.ratio < p.min);
    assert.deepEqual(failing, [], failing.map((p) => `${p.mode} ${p.fg} on ${p.on}: ${p.ratio} < ${p.min}`).join('\n'));
    assert.ok(t.pairs.length >= 68, `only ${t.pairs.length} pairs checked`);
  });
}

test('every app of the repository gets a palette that passes', () => {
  const apps = fs.readdirSync(path.join(ROOT, 'apps')).filter((a) => fs.existsSync(path.join(ROOT, 'apps', a, 'app.json')));
  const bad = [];
  for (const a of apps) for (const p of buildTheme(themeOf(a)).pairs) if (p.ratio < p.min) bad.push(`${a}: ${p.mode} ${p.fg}/${p.on} ${p.ratio}`);
  assert.deepEqual(bad, []);
});

test('the colour maths: named colours, OKLCH and WCAG agree with known values', () => {
  assert.deepEqual(parseColor('darkslateblue').map((v) => Math.round(v * 255)), [72, 61, 139]);
  const white = toOklch([1, 1, 1]), black = toOklch([0, 0, 0]);
  assert.ok(Math.abs(white.l - 1) < 1e-3 && Math.abs(black.l) < 1e-3);
  assert.ok(Math.abs(contrast(white, black) - 21) < 0.05, 'white on black is 21:1');
  assert.equal(Math.round(contrast(toOklch(parseColor('#767676')), white) * 100) / 100, 4.54);
});

test('the accent is the solid colour in light mode, and the CSS is deterministic', () => {
  const t = buildTheme({ background: 'seashell', accent: 'darkslateblue' });
  const a = toOklch(parseColor('darkslateblue'));
  assert.match(t.css.light.primary, new RegExp(`oklch\\(${a.l.toFixed(3)} `));
  assert.equal(themeCss({ background: 'seashell', accent: 'darkslateblue' }), themeCss({ background: 'seashell', accent: 'darkslateblue' }));
  assert.doesNotThrow(() => buildTheme({}), 'a graph without a theme gets the default palette');
});
