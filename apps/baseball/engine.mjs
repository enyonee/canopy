// Pure baseball simulation: seeded, deterministic, inning-by-inning with real
// (if simplified) base-running. No storage, no HTTP — kept out of plugins/,
// same reason and same shape as apps/chess/engine.mjs and apps/poker/engine.mjs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const DEFENSE_OUT_SHIFT = { conservative: 0.05, balanced: 0, aggressive: -0.05 };

// One batter's outcome: rating (1-99) shifts the whole distribution toward
// hits, the fielding team's defenseStrategy shifts it back toward outs.
function outcomeFor(rnd, rating, fieldingStrategy) {
  const skill = Math.max(1, Math.min(99, rating)) / 99; // 0..1
  const outShift = DEFENSE_OUT_SHIFT[fieldingStrategy] ?? 0;
  const pOut = Math.max(0.35, Math.min(0.85, 0.68 - 0.22 * skill + outShift));
  const pWalk = 0.08;
  const pHomerun = 0.02 + 0.05 * skill;
  const pTriple = 0.01 + 0.01 * skill;
  const pDouble = 0.05 + 0.06 * skill;
  const pSingle = Math.max(0, 1 - pOut - pWalk - pHomerun - pTriple - pDouble);
  const r = rnd();
  let acc = 0;
  for (const [name, p] of [['out', pOut], ['walk', pWalk], ['single', pSingle], ['double', pDouble], ['triple', pTriple], ['homerun', pHomerun]]) {
    acc += p;
    if (r < acc) return name;
  }
  return 'out';
}

// Advances baserunners (1st/2nd/3rd, true = occupied) for one outcome;
// returns { bases, runs, batterOut }. Advancement is simplified to "every
// runner moves exactly N bases" (no baserunning judgment/outs on the bases).
function advance(bases, outcome) {
  let [b1, b2, b3] = bases;
  let runs = 0;
  if (outcome === 'out') return { bases: [b1, b2, b3], runs: 0, batterOut: true };
  if (outcome === 'walk') {
    if (b1 && b2 && b3) { runs += 1; return { bases: [true, true, true], runs, batterOut: false }; }
    if (b1 && b2) return { bases: [true, true, true], runs, batterOut: false };
    if (b1) return { bases: [true, true, b3], runs, batterOut: false };
    return { bases: [true, b2, b3], runs, batterOut: false };
  }
  const steps = { single: 1, double: 2, triple: 3, homerun: 4 }[outcome];
  if (b3) { runs++; b3 = false; }
  if (b2) { if (2 + steps >= 4) runs++; else b3 = true; b2 = false; }
  if (b1) { if (1 + steps >= 4) runs++; else if (1 + steps === 3) b3 = true; else b2 = true; b1 = false; }
  if (steps >= 4) runs++;
  else if (steps === 3) b3 = true;
  else if (steps === 2) b2 = true;
  else b1 = true;
  return { bases: [b1, b2, b3], runs, batterOut: false };
}

// Simulates a full game. `homeLineup`/`awayLineup` are arrays of
// { id, name, rating } in batting order (any length >= 1; cycles). Returns
// the final score, a play-by-play log, and each batter's per-game stat delta
// (atBats/hits/homeRuns/rbis) keyed by player id, so the caller can fold it
// into cumulative season totals.
export function simulateGame(seed, homeLineup, awayLineup, homeDefense, awayDefense, innings = 9) {
  const rnd = mulberry32(seed);
  const log = [];
  let homeScore = 0, awayScore = 0;
  const stats = new Map();
  const bump = (id, field, by = 1) => { if (!stats.has(id)) stats.set(id, { atBats: 0, hits: 0, homeRuns: 0, rbis: 0 }); stats.get(id)[field] += by; };
  let homeIdx = 0, awayIdx = 0;

  // Plays one half-inning to 3 outs, pushing one log entry per at-bat with
  // the score exactly as it stood right after that play (read from the
  // outer homeScore/awayScore, which this function updates as runs cross
  // the plate — so mid-inning runs show up on the very play that scored
  // them, not only in the final tally).
  function playHalf(inning, half, battingLineup, fieldingStrategy, cursor) {
    let outs = 0, bases = [false, false, false], idx = cursor;
    while (outs < 3) {
      const batter = battingLineup[idx % battingLineup.length];
      idx++;
      const outcome = outcomeFor(rnd, batter.rating, fieldingStrategy);
      if (outcome !== 'walk') bump(batter.id, 'atBats');
      const { bases: next, runs: scored, batterOut } = advance(bases, outcome);
      bases = next;
      if (batterOut) outs++;
      if (outcome !== 'out' && outcome !== 'walk') { bump(batter.id, 'hits'); if (outcome === 'homerun') bump(batter.id, 'homeRuns'); }
      if (scored) {
        bump(batter.id, 'rbis', scored);
        if (half === 'top') awayScore += scored; else homeScore += scored;
      }
      log.push({
        seq: log.length + 1, inning, half, outs: Math.min(outs, 3),
        description: `${batter.name}: ${outcome}${scored ? ` (${scored} run${scored > 1 ? 's' : ''} in)` : ''}`,
        homeScoreAfter: homeScore, awayScoreAfter: awayScore,
      });
    }
    return { cursor: idx };
  }

  for (let inning = 1; inning <= innings; inning++) {
    awayIdx = playHalf(inning, 'top', awayLineup, homeDefense, awayIdx).cursor;
    homeIdx = playHalf(inning, 'bottom', homeLineup, awayDefense, homeIdx).cursor;
  }
  return { homeScore, awayScore, log, stats };
}
