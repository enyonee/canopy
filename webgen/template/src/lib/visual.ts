// Deterministic looks derived from data: the same name always gets the same cover, avatar colour and icon, so
// nothing is random between renders, builds or users. Colours stay inside the theme: hues are mixed with the
// graph's accent (--brand) in CSS.
import { app } from '@/gen/app';
import type { Entity } from '@/lib/model';

/** FNV-1a: a small, stable hash of a string. */
export function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** A hue (0–359) for a name, kept off the muddy greens and yellows that read badly as a background. */
export const hueOf = (s: string) => [210, 235, 260, 285, 310, 335, 15, 175, 195][hash(s) % 9];

/** An avatar's colours for a name: a tinted circle in light and dark. */
export const avatarStyle = (s: string) => ({
  background: `color-mix(in oklab, oklch(0.72 0.12 ${hueOf(s)}) 28%, var(--card))`,
  color: `color-mix(in oklab, oklch(0.45 0.14 ${hueOf(s)}) 85%, var(--foreground))`,
});

// The tone of each status, by its place in the state machine: the start is neutral, statuses along the way take
// distinct hues in order, the end of the happy path is green, a status only a cancel-like step reaches is red.
const WAY = ['sky', 'violet', 'amber', 'teal', 'indigo', 'fuchsia'] as const;
export type Tone = 'slate' | 'emerald' | 'rose' | (typeof WAY)[number];

export function statusTone(entity: Entity, value: string): Tone {
  const st = entity.states;
  const field = entity.fields.find((f) => f.name === st?.field);
  const options = field?.options ?? [];
  if (!st) return 'slate';
  const bad = new Set(st.transitions.filter((t) => t.destructive).map((t) => t.to));
  if (bad.has(value) || /cancel|reject|fail|declin|refund|lost/i.test(value)) return 'rose';
  if (value === field?.default) return 'slate';
  const way = options.filter((o) => !bad.has(o) && o !== field?.default);
  const at = way.indexOf(value);
  if (at === way.length - 1 || /deliver|done|complete|won|resolv/i.test(value)) return 'emerald';
  return WAY[Math.max(0, at) % WAY.length];
}

// lucide icon names for what a category or an entity is called; the cover and the badges use them.
const ICON_WORDS: [RegExp, string][] = [
  [/mug|cup|coffee|tea/i, 'coffee'], [/poster|print|art|photo|image|picture/i, 'image'], [/book|read/i, 'book'],
  [/shirt|cloth|apparel|wear|fashion/i, 'shirt'], [/shoe|sneaker/i, 'footprints'], [/music|vinyl|record|audio/i, 'music'],
  [/game|toy/i, 'gamepad'], [/food|grocer|snack|fruit/i, 'apple'], [/plant|garden|flower/i, 'flower'],
  [/tech|laptop|computer|electronic|software/i, 'laptop'], [/home|furniture|decor/i, 'sofa'], [/gift/i, 'gift'],
  [/car|auto|vehicle/i, 'car'], [/health|medic|pharma|drug/i, 'pill'], [/sport|fitness/i, 'dumbbell'], [/ticket|event/i, 'ticket'],
];
export const iconWord = (...words: (string | null | undefined)[]) =>
  ICON_WORDS.find(([re]) => words.some((w) => w && re.test(w)))?.[1] ?? 'package';

/** The field a storefront card shows as a stock chip: an integer named like a quantity on hand. */
export const stockField = (entity: Entity) => entity.fields.find((f) => f.type === 'integer' && !f.derived && /stock|quantity|inventory|available|seats|left/i.test(f.name)) ?? null;

export const appInitial = () => app.title.slice(0, 1).toUpperCase();

/** A status tone as a colour an SVG fill can take (charts colour status groups like the badges). */
export const TONE_COLOR: Record<Tone, string> = {
  slate: 'oklch(0.6 0.03 260)', sky: 'oklch(0.68 0.14 230)', violet: 'oklch(0.6 0.2 293)', amber: 'oklch(0.77 0.16 70)',
  teal: 'oklch(0.7 0.12 185)', indigo: 'oklch(0.55 0.2 277)', fuchsia: 'oklch(0.67 0.24 322)', emerald: 'oklch(0.7 0.15 162)', rose: 'oklch(0.65 0.21 16)',
};
