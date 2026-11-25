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

/** An avatar's colours for a name: one of the theme's ordinal tones, picked by hash (contrast-checked). */
export const avatarStyle = (s: string) => {
  const t = `var(--tone-${(hash(s) % 6) + 1}`;
  return { background: `${t}-bg)`, color: `${t}-fg)` };
};

// The tone of each status, by its place in the state machine: the start is neutral (0), the statuses along the way
// take the theme's ordinal tones 1–6 in order, the end of the happy path is success, a status only a cancel-like step
// reaches is danger. The colours are generated per theme and checked for contrast (src/gen/theme.css).
export type Tone = 'tone-0' | 'tone-1' | 'tone-2' | 'tone-3' | 'tone-4' | 'tone-5' | 'tone-6' | 'success' | 'danger' | 'warning';

export function statusTone(entity: Entity, value: string): Tone {
  const st = entity.states;
  const field = entity.fields.find((f) => f.name === st?.field);
  if (!st) return 'tone-0';
  const bad = new Set(st.transitions.filter((t) => t.destructive).map((t) => t.to));
  if (bad.has(value)) return 'danger';
  if (value === field?.default) return 'tone-0';
  const way = (field?.options ?? []).filter((o) => !bad.has(o) && o !== field?.default);
  const at = way.indexOf(value);
  if (at === way.length - 1) return 'success';
  return `tone-${(Math.max(0, at) % 6) + 1}` as Tone;
}

/** A tone's badge background, text and dot as CSS colours. */
export const toneVars = (t: Tone) => ({ bg: `var(--${t}-bg)`, fg: `var(--${t}-fg)`, dot: `var(--${t}-dot)` });

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


/** The ordinal tone (1–6) of a category, by a hash of its name: every row of one category shares it. */
export const categoryTone = (name: string | null | undefined) => (name ? (hash(name) % 6) + 1 : 0);
