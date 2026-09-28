// Pure Texas Hold'em engine: deck/shuffle, deterministic dealing, and 7-card
// best-hand evaluation. No storage, no HTTP — kept out of plugins/ for the
// same reason apps/chess/engine.mjs is (see that file's header): imported by
// plugins/poker.mjs (server blocks) and by checks.mjs (the oracle).
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
export const FULL_DECK = RANKS.split('').flatMap((r) => SUITS.split('').map((s) => r + s));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A fresh, fully shuffled 52-card deck for (roomId, handNumber) — the whole
// hand's dealing (holes, flop, turn, river) is just slices of this one array
// at increasing offsets, so it never repeats a card and is fully replayable
// by a check that knows only the seed.
export function shuffledDeck(seed) {
  const rnd = mulberry32(seed >>> 0);
  const deck = FULL_DECK.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rankValue = (c) => RANKS.indexOf(c[0]) + 2;

// Best 5-card score among all C(7,5)=21 combinations of `cards` (2-7 cards
// supported; poker itself always calls this with 5-7). Score is an array
// compared lexicographically: [category 0-8, then tiebreak ranks high to
// low] — category 8 = straight flush down to 0 = high card.
function scoreOf5(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map((c) => c[1]);
  const isFlush = suits.every((s) => s === suits[0]);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const uniqueDesc = [...new Set(ranks)];
  let straightHigh = null;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) straightHigh = uniqueDesc[0];
    else if (uniqueDesc.join(',') === '14,5,4,3,2') straightHigh = 5; // wheel: A-2-3-4-5
  }
  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  return [0, ...ranks];
}

const cmpScore = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; } return 0; };

const combos5 = (cards) => {
  if (cards.length <= 5) return [cards];
  const out = [];
  const pick = (start, chosen) => {
    if (chosen.length === 5) { out.push(chosen.slice()); return; }
    for (let i = start; i < cards.length; i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop(); }
  };
  pick(0, []);
  return out;
};

const CATEGORY_NAME = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// Best 5-card hand (and its name) out of 5-7 cards.
export function bestHand(cards) {
  let best = null, bestCards = null;
  for (const five of combos5(cards)) {
    const score = scoreOf5(five);
    if (!best || cmpScore(score, best) > 0) { best = score; bestCards = five; }
  }
  return { score: best, cards: bestCards, name: CATEGORY_NAME[best[0]] };
}
export const compareHands = (a, b) => cmpScore(a.score, b.score);
