// Server side of the baseball app: registry glue around the pure, seeded
// simulation in ../engine.mjs (kept out of this directory — same reason and
// shape as apps/chess/engine.mjs and apps/poker/engine.mjs).
import { simulateGame } from '../engine.mjs';

function lineupOf(store, teamId) {
  return store.list('Player', { where: { team: teamId }, sort: { field: 'battingOrder', dir: 'asc' } })
    .map((p) => ({ id: p.id, name: p.name, rating: p.rating }));
}

export default {
  blocks: {
    // Game.created event: the standard entity-create route fires this (a
    // global action's db.createRow would not — see apps/chess and
    // apps/poker's NOTES.md for the same recorded miss), so "create a game"
    // (the normal /Game form) doubles as "start its simulation" — the
    // closest honest reading of "initiate a new game simulation" in a
    // request/response format with no background jobs.
    'baseball.simulate': {
      summary: 'simulate the freshly-created game inning by inning (seeded by its own id), writing the play-by-play, the final score, each batter\'s stat line and both teams\' win/loss record',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id }) => {
        const game = store.get(entity, id);
        const home = store.get('Team', game.home);
        const away = store.get('Team', game.away);
        const homeLineup = lineupOf(store, game.home);
        const awayLineup = lineupOf(store, game.away);
        if (!homeLineup.length || !awayLineup.length) throw new Error('Both teams need at least one player on the roster before simulating');
        const result = simulateGame(id, homeLineup, awayLineup, home.defenseStrategy, away.defenseStrategy, game.innings);
        for (const p of result.log)
          store.insert('Play', { game: id, seq: p.seq, inning: p.inning, half: p.half, description: p.description, homeScoreAfter: p.homeScoreAfter, awayScoreAfter: p.awayScoreAfter });
        for (const [playerId, delta] of result.stats) {
          const player = store.get('Player', playerId);
          store.update('Player', playerId, { atBats: player.atBats + delta.atBats, hits: player.hits + delta.hits, homeRuns: player.homeRuns + delta.homeRuns, rbis: player.rbis + delta.rbis });
        }
        store.update(entity, id, {
          status: 'finished', homeScore: result.homeScore, awayScore: result.awayScore,
          homeDefenseUsed: home.defenseStrategy, awayDefenseUsed: away.defenseStrategy,
        });
        if (result.homeScore !== result.awayScore) {
          const winner = result.homeScore > result.awayScore ? game.home : game.away;
          const loser = result.homeScore > result.awayScore ? game.away : game.home;
          const wt = store.get('Team', winner); store.update('Team', winner, { wins: wt.wins + 1 });
          const lt = store.get('Team', loser); store.update('Team', loser, { losses: lt.losses + 1 });
        }
        return {};
      },
    },
  },
};
// Note: adjusting a team's defense strategy and its budget/training-budget
// split are both plain edits of Team.form's fields (see app.json) — real
// business rules ("neither budget may go negative") live in /rules, not in
// a bespoke block; no custom block was needed for either ui_instruct case.
