// The palette of a generated front end, from the two colours of the graph's `theme`: 12-step OKLCH scales (Radix-like
// roles: 1–2 app backgrounds, 3–5 component backgrounds, 6–8 borders, 9–10 solid, 11–12 text) for the accent hue
// and for neutrals tinted by the background, light and dark, mapped to the shadcn tokens. Every pair the screens put
// text or data on is checked against WCAG 2.2 and its lightness moved until it passes; `pairs` lists the result.
import { parseColor, toOklch, css, contrast, ensure, onSolid, inGamut } from './color.mjs';

const LIGHT_L = [0.993, 0.972, 0.945, 0.92, 0.895, 0.865, 0.825, 0.76, 0.62, 0.58, 0.47, 0.25];
const DARK_L = [0.165, 0.195, 0.225, 0.255, 0.285, 0.32, 0.37, 0.44, 0.62, 0.66, 0.8, 0.95];

// Chroma of an accent step: faint for backgrounds, stronger for borders, the accent's own for solids, toned down for text.
const accentC = (c0, step, dark) => {
  const f = [0.08, 0.14, 0.22, 0.3, 0.38, 0.46, 0.56, 0.7, 1, 1, 0.75, 0.45][step - 1];
  return c0 * f * (dark ? 0.85 : 1);
};

function scale(base, dark, neutral) {
  const Ls = dark ? DARK_L : LIGHT_L;
  return Object.fromEntries(Ls.map((l, i) => {
    const step = i + 1;
    const c = neutral ? Math.min(base.c, 0.02) * (step >= 11 ? 0.6 : 1) * (dark ? 0.7 : 1) : accentC(base.c, step, dark);
    return [step, inGamut({ l, c, h: base.h })];
  }));
}

// Hues of the status steps: the accent's, turned, so that neighbouring statuses differ; meanings keep their own hue.
const SEMANTIC = { success: 150, warning: 75, danger: 25 };
const TONE_TURNS = [0, 45, 300, 180, 90, 225];

function tone(h, chroma, surface, dark) {
  const bg = inGamut({ l: dark ? 0.3 : 0.94, c: chroma * (dark ? 0.35 : 0.3), h });
  const fg = ensure({ l: dark ? 0.85 : 0.42, c: chroma * 0.8, h }, bg, 4.5, dark ? 1 : -1);
  const dot = ensure({ l: dark ? 0.72 : 0.58, c: chroma, h }, surface, 3, dark ? 1 : -1);
  return { bg, fg, dot };
}

function palette(bgBase, accent, dark) {
  const n = scale(bgBase, dark, true);
  const a = scale(accent, dark, false);
  const background = dark ? n[1] : n[2];
  const card = dark ? n[2] : n[1];
  const t = {};
  t.background = background; t.card = card; t.popover = card;
  t.foreground = ensure(n[12], background, 7, dark ? 1 : -1);
  t['card-foreground'] = t.foreground; t['popover-foreground'] = t.foreground;
  t.muted = n[3];
  t['muted-foreground'] = ensure(ensure(ensure(n[11], background, 4.5, dark ? 1 : -1), card, 4.5, dark ? 1 : -1), n[3], 4.5, dark ? 1 : -1);
  // The accent as the solid: the graph's own colour in light; in dark lifted until a button stands out from the page.
  const solid = dark ? ensure({ ...accent, c: Math.min(accent.c, 0.16) }, background, 3, 1) : ensure(accent, background, 3, -1);
  // Text on the solid: white or near-black, whichever reads better; when neither reaches 4.5:1 (a mid-tone accent)
  // the solid itself moves away from its text until it does.
  const onIt = onSolid(solid, accent.h);
  const fixed = ensure(solid, onIt, 4.5, onIt.l > 0.5 ? -1 : 1);
  t.primary = fixed;
  t['primary-foreground'] = onIt;
  t.secondary = a[3]; t['secondary-foreground'] = ensure(a[12], a[3], 4.5, dark ? 1 : -1);
  t.accent = a[3]; t['accent-foreground'] = t['secondary-foreground'];
  t.border = dark ? n[6] : n[6];
  t.input = ensure(n[8], background, 3, dark ? 1 : -1);
  t.ring = ensure(a[8], background, 3, dark ? 1 : -1);
  t.sidebar = dark ? n[1] : n[3];
  t.brand = fixed; // the accent itself, for gradients and marks
  t['brand-soft'] = a[4];
  t['sidebar-border'] = n[6];
  t['accent-text'] = ensure(a[11], card, 4.5, dark ? 1 : -1); // accent-coloured text: links
  t.destructive = ensure({ l: dark ? 0.68 : 0.55, c: 0.19, h: 25 }, card, 4.5, dark ? 1 : -1);
  // Charts: one hue (the accent) at three depths plus two neutrals, each readable on a card (3:1, WCAG 1.4.11).
  t['chart-1'] = ensure(fixed, card, 3, dark ? 1 : -1);
  t['chart-2'] = ensure(inGamut({ l: dark ? 0.75 : 0.7, c: accent.c * 0.7, h: accent.h }), card, 3, dark ? 1 : -1);
  t['chart-3'] = ensure(inGamut({ l: dark ? 0.55 : 0.45, c: accent.c * 0.9, h: (accent.h + 330) % 360 }), card, 3, dark ? 1 : -1);
  t['chart-4'] = ensure(n[9], card, 3, dark ? 1 : -1);
  t['chart-5'] = ensure(n[10], card, 3, dark ? 1 : -1);
  const chroma = Math.max(0.12, Math.min(accent.c, 0.18));
  for (const [name, h] of Object.entries(SEMANTIC)) {
    const s = tone(h, 0.16, card, dark);
    t[`${name}-bg`] = s.bg; t[`${name}-fg`] = s.fg; t[`${name}-dot`] = s.dot;
  }
  const neutral = { bg: n[3], fg: ensure(n[11], n[3], 4.5, dark ? 1 : -1), dot: ensure(n[9], card, 3, dark ? 1 : -1) };
  t['tone-0-bg'] = neutral.bg; t['tone-0-fg'] = neutral.fg; t['tone-0-dot'] = neutral.dot;
  TONE_TURNS.forEach((turn, i) => {
    const s = tone((accent.h + turn) % 360, chroma, card, dark);
    t[`tone-${i + 1}-bg`] = s.bg; t[`tone-${i + 1}-fg`] = s.fg; t[`tone-${i + 1}-dot`] = s.dot;
  });
  return t;
}

// The pairs the screens draw, with the WCAG minimum each needs: text 4.5:1, UI parts and chart marks 3:1.
const PAIRS = [
  ['foreground', 'background', 4.5], ['foreground', 'card', 4.5], ['muted-foreground', 'background', 4.5], ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5], ['primary-foreground', 'primary', 4.5], ['secondary-foreground', 'secondary', 4.5], ['accent-text', 'card', 4.5],
  ['destructive', 'card', 4.5], ['primary', 'background', 3], ['input', 'background', 3], ['ring', 'background', 3],
  ['chart-1', 'card', 3], ['chart-2', 'card', 3], ['chart-3', 'card', 3], ['chart-4', 'card', 3], ['chart-5', 'card', 3],
  ...['success', 'warning', 'danger'].map((s) => [`${s}-fg`, `${s}-bg`, 4.5]),
  ...[0, 1, 2, 3, 4, 5, 6].flatMap((i) => [[`tone-${i}-fg`, `tone-${i}-bg`, 4.5], [`tone-${i}-dot`, 'card', 3]]),
];

/**
 * The theme of a graph: CSS custom properties for light and dark, and the contrast of every checked pair.
 * @param {{ background?: string|null, accent?: string|null }} theme
 */
export function buildTheme(theme = {}) {
  const bgRgb = parseColor(theme.background) ?? [1, 1, 1];
  const acRgb = parseColor(theme.accent) ?? parseColor('#4f46e5');
  const accent = toOklch(acRgb);
  const bg = toOklch(bgRgb);
  // A near-grey background takes the accent's hue, so the neutrals are not tinted at random.
  const bgBase = bg.c < 0.004 ? { ...bg, h: accent.h, c: 0.008 } : bg;
  const modes = { light: palette(bgBase, accent, false), dark: palette(bgBase, accent, true) };
  const pairs = Object.entries(modes).flatMap(([mode, t]) => PAIRS.map(([fg, on, min]) => ({ mode, fg, on, min, ratio: Math.round(contrast(t[fg], t[on]) * 100) / 100 })));
  const cssVars = Object.fromEntries(Object.entries(modes).map(([m, t]) => [m, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, css(v)]))]));
  return { css: cssVars, pairs, source: { background: theme.background ?? null, accent: theme.accent ?? null } };
}

/** The theme as the generated src/gen/theme.css. */
export function themeCss(theme) {
  const t = buildTheme(theme);
  const block = (sel, vars) => `${sel} {\n${Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}\n`;
  const worst = Math.min(...t.pairs.map((p) => p.ratio / p.min));
  return `/* Generated by webgen from the graph's theme (background: ${t.source.background}, accent: ${t.source.accent}).
   OKLCH scales checked against WCAG 2.2: ${t.pairs.length} pairs, the tightest at ${worst.toFixed(2)}× its minimum. Do not edit. */
${block(':root', t.css.light)}${block('.dark', t.css.dark)}`;
}
