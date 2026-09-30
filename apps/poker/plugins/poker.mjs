// Server side of the poker app: registry glue (blocks) around the pure deck
// and hand-evaluation engine in ../engine.mjs (kept out of this directory —
// same reason as apps/chess/engine.mjs). The server is the sole authority:
// every deal, bet and showdown decision happens here; the widget only
// renders the table and posts an action name.
//
// Betting is deliberately simple (see NOTES.md "Weakened cases"): one fixed
// bet per street (no re-raising) — fold / check / call / bet(fixed = big
// blind). A street closes once every seat still in the hand has acted at
// least once *and* matches the current bet. Bots act immediately, in the
// same request, whenever it becomes their turn (same pattern as the AI
// reply in apps/chess and apps/game2048).
import { shuffledDeck, bestHand } from '../engine.mjs';

const RANKS = '23456789TJQKA';
const sameUser = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);
const rankValue = (c) => RANKS.indexOf(c[0]) + 2;

async function seatsOf(store, roomId) {
  return await store.list('Seat', { where: { room: roomId }, sort: { field: 'position', dir: 'asc' } });
}
function nextActive(seats, from) {
  const n = seats.length;
  for (let k = 1; k <= n; k++) { const s = seats[(from + k) % n]; if (!s.folded) return (from + k) % n; }
  return from;
}
async function bump(store, userId, field) {
  if (!userId) return;
  const u = await store.get('User', userId);
  if (u) await store.update('User', userId, { [field]: (u[field] || 0) + 1 });
}

// Deals hole cards, posts blinds, and opens the first street of a new hand
// for a room whose seats already exist (bots included).
async function dealNewHand(store, room) {
  let seats = await seatsOf(store, room.id);
  const handNumber = room.handNumber + 1;
  const seed = Number(room.id) * 1_000_003 + handNumber;
  const deck = shuffledDeck(seed);
  let deckIndex = 0;
  for (const s of seats) {
    const busted = s.chips <= 0;
    await store.update('Seat', s.id, { holeCards: busted ? '' : deck.slice(deckIndex, deckIndex + (busted ? 0 : 2)).join(','), committed: 0, folded: busted ? 1 : 0, actedThisStreet: 0 });
    if (!busted) deckIndex += 2;
  }
  seats = await seatsOf(store, room.id);
  const n = seats.length;
  const dealerPos = (handNumber - 1) % n;
  const sbPos = n === 2 ? dealerPos : (dealerPos + 1) % n;
  const bbPos = n === 2 ? (dealerPos + 1) % n : (dealerPos + 2) % n;
  const sbSeat = seats[sbPos], bbSeat = seats[bbPos];
  const sbAmt = Math.min(room.smallBlind, sbSeat.chips);
  const bbAmt = Math.min(room.bigBlind, bbSeat.chips);
  await store.update('Seat', sbSeat.id, { committed: sbAmt, chips: sbSeat.chips - sbAmt });
  await store.update('Seat', bbSeat.id, { committed: bbAmt, chips: bbSeat.chips - bbAmt });
  const handId = await store.insert('Hand', {
    room: room.id, number: handNumber, stage: 'preflop', pot: sbAmt + bbAmt, community: '',
    dealerPos, toActPos: nextActive(seats, bbPos), currentBet: Math.max(sbAmt, bbAmt), deckIndex,
    winnerLabel: '', winningHandName: '',
  });
  await store.update('Room', room.id, { handNumber, currentHand: handId, status: 'playing' });
  return handId;
}

const STREET_DEAL = { preflop: 3, flop: 1, turn: 1 }; // cards to reveal moving INTO flop/turn/river
const NEXT_STAGE = { preflop: 'flop', flop: 'turn', turn: 'river' };

// Ends the hand outright (everyone but one folded, or the river closed):
// evaluates showdown if more than one seat remains, pays the pot, bumps
// User stats, and marks both the Hand and — implicitly, by leaving status
// "playing" — the Room ready for another "startHand".
async function finishHand(store, room, hand, seats) {
  const live = seats.filter((s) => !s.folded);
  let winner, handName = '';
  if (live.length === 1) { winner = live[0]; handName = 'Everyone else folded'; }
  else {
    const community = hand.community ? hand.community.split(',') : [];
    const evaluated = live.map((s) => ({ seat: s, ...bestHand([...s.holeCards.split(','), ...community]) }));
    evaluated.sort((a, b) => {
      for (let i = 0; i < 9; i++) { const d = (b.score[i] ?? -1) - (a.score[i] ?? -1); if (d) return d; }
      return 0;
    });
    winner = evaluated[0].seat; handName = evaluated[0].name;
  }
  await store.update('Seat', winner.id, { chips: winner.chips + hand.pot });
  await store.update('Hand', hand.id, { stage: 'done', winnerLabel: winner.label, winningHandName: handName });
  for (const s of seats) if (s.user) await bump(store, s.user, 'handsPlayed');
  if (winner.user) await bump(store, winner.user, 'handsWon');
}

// Advances to the next street (or showdown/done) once every live seat has
// matched the current bet and acted at least once this street.
async function closeStreet(store, room, hand, seats) {
  const live = seats.filter((s) => !s.folded);
  for (const s of live) await store.update('Seat', s.id, { committed: 0, actedThisStreet: 0 });
  if (hand.stage === 'river') { await finishHand(store, room, hand, await seatsOf(store, room.id)); return; }
  const next = NEXT_STAGE[hand.stage];
  const seed = Number(room.id) * 1_000_003 + hand.number;
  const deck = shuffledDeck(seed);
  const reveal = deck.slice(hand.deckIndex, hand.deckIndex + STREET_DEAL[hand.stage]);
  const community = (hand.community ? hand.community.split(',') : []).concat(reveal).join(',');
  const toActPos = nextActive(await seatsOf(store, room.id), hand.dealerPos);
  await store.update('Hand', hand.id, { stage: next, community, currentBet: 0, deckIndex: hand.deckIndex + reveal.length, toActPos });
}

async function applyAction(store, room, hand, seats, seat, action) {
  if (action === 'fold') { await store.update('Seat', seat.id, { folded: 1, actedThisStreet: 1 }); }
  else if (action === 'check') {
    if (seat.committed !== hand.currentBet) throw new Error('You cannot check facing a bet — call or fold');
    await store.update('Seat', seat.id, { actedThisStreet: 1 });
  } else if (action === 'call') {
    const owe = Math.min(hand.currentBet - seat.committed, seat.chips);
    await store.update('Seat', seat.id, { committed: seat.committed + owe, chips: seat.chips - owe, actedThisStreet: 1 });
    await store.update('Hand', hand.id, { pot: hand.pot + owe });
  } else if (action === 'bet') {
    if (hand.currentBet > 0) throw new Error('Someone already bet this street — call or fold');
    const amt = Math.min(room.bigBlind, seat.chips);
    await store.update('Seat', seat.id, { committed: seat.committed + amt, chips: seat.chips - amt, actedThisStreet: 1 });
    await store.update('Hand', hand.id, { pot: hand.pot + amt, currentBet: seat.committed + amt });
  } else throw new Error(`unknown action "${action}"`);
}

// Runs one seat's turn (human or bot) to completion: apply the action, then
// either finish the hand (one seat left), close the street (everyone has
// matched and acted), or hand the turn to the next live seat.
async function takeTurn(store, room, handId, action) {
  let hand = await store.get('Hand', handId);
  let seats = await seatsOf(store, room.id);
  const seat = seats[hand.toActPos];
  await applyAction(store, room, hand, seats, seat, action);
  hand = await store.get('Hand', handId);
  seats = await seatsOf(store, room.id);
  const live = seats.filter((s) => !s.folded);
  if (live.length === 1) { await finishHand(store, room, hand, seats); return; }
  const allMatched = live.every((s) => s.actedThisStreet && s.committed === hand.currentBet);
  if (allMatched) { await closeStreet(store, room, hand, seats); return; }
  await store.update('Hand', handId, { toActPos: nextActive(seats, hand.toActPos) });
}

function botAction(store, room, hand, seat) {
  const rnd = mulberryFloat(Number(room.id) * 1_000_003 + hand.number * 97 + seat.position * 13 + hand.deckIndex);
  const [c1, c2] = seat.holeCards.split(',');
  const strength = (c1 ? rankValue(c1) : 0) + (c2 ? rankValue(c2) : 0) + (c1 && c2 && c1[0] === c2[0] ? 10 : 0);
  const facing = hand.currentBet > seat.committed;
  if (facing) return strength >= 15 || rnd < 0.25 ? 'call' : 'fold';
  return hand.currentBet === 0 && strength >= 20 && rnd < 0.5 ? 'bet' : 'check';
}
function mulberryFloat(seed) {
  let a = seed >>> 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// After a human's action (or as part of starting a hand), resolve every
// consecutive bot turn immediately, in the same request — same convention
// as the AI reply in apps/chess and apps/game2048.
async function resolveBots(store, roomId, handId) {
  for (let guard = 0; guard < 200; guard++) {
    const room = await store.get('Room', roomId);
    const hand = await store.get('Hand', handId);
    if (!hand || hand.stage === 'done') return;
    const seats = await seatsOf(store, roomId);
    const seat = seats[hand.toActPos];
    if (!seat.isBot) return;
    await takeTurn(store, room, handId, botAction(store, room, hand, seat));
  }
}

export default {
  blocks: {
    // Room.created event (db.create's own route fires it; see docs/FORMAT.md
    // — a global action's db.createRow would not): seats the creator at
    // position 0 the moment their table exists, same "create the row on the
    // real form route so events actually fire" approach apps/chess uses for
    // Game.created.
    'poker.seatCreator': {
      summary: 'seat the room\'s creator at position 0 right after it is created',
      effects: ['db.write'], requires: [],
      run: async ({ store, entity, id, user }) => {
        await store.insert('Seat', { room: id, user: user.id, isBot: 0, position: 0, label: user.name, chips: 1000, holeCards: '', committed: 0, folded: 0, actedThisStreet: 0 });
        return {};
      },
    },
    'poker.join': {
      summary: 'seat the current user at the next open position',
      effects: ['db.write'], requires: [],
      run: async ({ store, entity, id, user }) => {
        const room = await store.get(entity, id);
        if (room.status !== 'waiting') throw new Error('This table is no longer accepting players');
        const seats = await seatsOf(store, id);
        if (seats.some((s) => sameUser(s.user, user.id))) throw new Error('You are already seated at this table');
        if (seats.length >= room.maxSeats) throw new Error('This table is full');
        await store.insert('Seat', { room: id, user: user.id, isBot: 0, position: seats.length, label: user.name, chips: 1000, holeCards: '', committed: 0, folded: 0, actedThisStreet: 0 });
        return {};
      },
    },
    'poker.startHand': {
      summary: 'fill any empty seats with bots (first time only) and deal a fresh hand',
      effects: ['db.write'], requires: [],
      run: async ({ store, entity, id }) => {
        const room = await store.get(entity, id);
        let seats = await seatsOf(store, id);
        if (!seats.length) throw new Error('Take a seat before starting a hand');
        if (room.status === 'waiting') {
          for (let p = seats.length; p < room.maxSeats; p++)
            await store.insert('Seat', { room: id, user: null, isBot: 1, position: p, label: `Bot ${p + 1}`, chips: 1000, holeCards: '', committed: 0, folded: 0, actedThisStreet: 0 });
          seats = await seatsOf(store, id);
        }
        if (seats.filter((s) => s.chips > 0).length < 2) throw new Error('Not enough players with chips left to start a hand');
        const handId = await dealNewHand(store, await store.get(entity, id));
        await resolveBots(store, id, handId);
        return {};
      },
    },
    'poker.act': {
      summary: 'the current user takes their turn ("action": fold, check, call or bet); refuses out-of-turn or invalid actions; resolves any following bot turns in the same request',
      effects: ['db.write'], requires: ['action'],
      run: async ({ store, entity, id, step, resolve, user }) => {
        const room = await store.get(entity, id);
        if (room.status !== 'playing' || !room.currentHand) throw new Error('No hand is in progress');
        const hand = await store.get('Hand', room.currentHand);
        if (!hand || hand.stage === 'done') throw new Error('No hand is in progress');
        const seats = await seatsOf(store, id);
        const seat = seats[hand.toActPos];
        if (!seat || !sameUser(seat.user, user.id)) throw new Error('It is not your turn');
        const action = String((await resolve({ v: step.action })).v);
        await takeTurn(store, room, hand.id, action);
        await resolveBots(store, id, hand.id);
        return {};
      },
    },
  },
  widgets: {
    poker: {
      summary: 'a Texas Hold\'em table: seats, hole/community cards, pot and betting controls; posts fold/check/call/bet',
      client: './poker.client.mjs',
    },
  },
};
