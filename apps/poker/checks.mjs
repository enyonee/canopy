// Acceptance checks for webgen-bench/000007 (poker), one per ui_instruct case
// in order, the last being the colour check. Uses ./engine.mjs (the same
// deterministic shuffle + hand evaluator plugins/poker.mjs runs) as an oracle
// to predict dealt cards and showdown winners exactly, the same
// "deterministic randomness" pattern as apps/chess and apps/game2048.
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';
import { shuffledDeck, bestHand } from './engine.mjs';

function makeClient(base) {
  let cookie = '';
  const keep = (r) => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const hdrs = (json) => ({ ...(cookie ? { cookie } : {}), ...(json ? { accept: 'application/json' } : {}) });
  const get = async (path, { json = false } = {}) => {
    const r = await fetch(base + path, { headers: hdrs(json), redirect: 'manual' });
    keep(r);
    const text = await r.text();
    return { status: r.status, html: text, body: json && text ? JSON.parse(text) : null };
  };
  const post = async (path, body = {}, { json = false } = {}) => {
    const r = await fetch(base + path, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...hdrs(json) }, body: new URLSearchParams(body).toString() });
    keep(r);
    const text = await r.text();
    return { status: r.status, html: text, body: json && text ? JSON.parse(text) : null };
  };
  const login = async (loginField, password) => post('/login', { login: loginField, password });
  return { get, post, login, cookie: () => cookie };
}

async function seatsOf(client, roomId) { return (await client.get(`/Seat?room=${roomId}`, { json: true })).body.rows.sort((a, b) => a.position - b.position); }
async function handOf(client, id) { return (await client.get(`/Hand/${id}`, { json: true })).body; }

// Predicts the deal for a brand-new hand exactly as plugins/poker.mjs's
// dealNewHand() computes it: seed = roomId*1_000_003 + handNumber, N seats
// each get 2 cards in position order.
function predictDeal(roomId, handNumber, seatCount) {
  const deck = shuffledDeck(Number(roomId) * 1_000_003 + handNumber);
  const holes = [];
  for (let i = 0; i < seatCount; i++) holes.push(deck.slice(i * 2, i * 2 + 2));
  return { deck, holes };
}

export const checks = [
  { task: 'The game lobby displays all available game rooms with status and player information',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@poker.test', 'alice123');
      const lobby = await alice.get('/Room');
      must(lobby.status === 200, `lobby did not load: ${lobby.status}`);
      must(/High Rollers/.test(lobby.html) && /Friday Night/.test(lobby.html), 'the seeded rooms are not listed');
      // Room.status is a plain enum here (no /states — see NOTES.md), so it
      // renders as plain text, not the special "<span class=status>" markup
      // that only applies to the field named in a states-governed entity.
      must(/<td>waiting<\/td>/.test(lobby.html), 'room status is not shown');
      const json = await alice.get('/Room', { json: true });
      must(json.body.rows.every((r) => 'maxSeats' in r && 'handNumber' in r), 'room rows are missing player/status information');
      return `lobby lists ${json.body.rows.length} rooms with status and seat/hand info visible`;
    } },

  { task: 'Creating a new game room makes it appear immediately in the lobby with the creator as the initial player',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@poker.test', 'alice123');
      const created = await alice.post('/Room', { name: 'Aces High', maxSeats: '3' }, { json: true });
      must(created.status === 200 && created.body.ok, `room creation failed: ${JSON.stringify(created.body)}`);
      const id = created.body.id;
      const lobby = await alice.get('/Room');
      must(new RegExp(`Aces High`).test(lobby.html), 'the new room is not in the lobby');
      const seats = await seatsOf(alice, id);
      must(seats.length === 1 && seats[0].label === 'Alice' && !seats[0].isBot, `the creator was not seated: ${JSON.stringify(seats)}`);
      return `Room #${id} "Aces High" appears in the lobby immediately, with Alice seated as the sole initial player`;
    } },

  { task: 'A user can join an existing game room and is added to the player list',
    run: async ({ base, must }) => {
      const alice = makeClient(base); const bob = makeClient(base);
      await alice.login('alice@poker.test', 'alice123');
      await bob.login('bob@poker.test', 'bob12345');
      const created = await alice.post('/Room', { name: 'Join Test', maxSeats: '3' }, { json: true });
      const id = created.body.id;
      const joined = await bob.post(`/Room/${id}/action/join`, {}, { json: true });
      must(joined.status === 200 && joined.body.ok, `join failed: ${JSON.stringify(joined.body)}`);
      const seats = await seatsOf(alice, id);
      must(seats.length === 2 && seats.some((s) => s.label === 'Bob' && s.position === 1), `Bob was not added to the seat list: ${JSON.stringify(seats)}`);
      const dupe = await bob.post(`/Room/${id}/action/join`, {}, { json: true });
      must(dupe.status === 400, `joining twice was not refused: ${dupe.status}`);
      return `Bob joined Room #${id}, now 2 seated players; joining a second time is refused`;
    } },

  { task: 'A round of Texas Hold\'em can be played: hole cards, community cards, betting info and action buttons all work',
    run: async ({ base, must }) => {
      const alice = makeClient(base); const bob = makeClient(base);
      await alice.login('alice@poker.test', 'alice123');
      await bob.login('bob@poker.test', 'bob12345');
      const created = await alice.post('/Room', { name: 'Heads Up', maxSeats: '2' }, { json: true });
      const id = created.body.id;
      await bob.post(`/Room/${id}/action/join`, {}, { json: true });
      const started = await alice.post(`/Room/${id}/action/startHand`, {}, { json: true });
      must(started.status === 200 && started.body.row.status === 'playing' && started.body.row.handNumber === 1, `hand did not start: ${JSON.stringify(started.body)}`);
      const handId = started.body.row.currentHand;
      let seats = await seatsOf(alice, id);
      const predicted = predictDeal(id, 1, 2);
      must(seats.every((s, i) => s.holeCards === predicted.holes[i].join(',')), `dealt hole cards do not match the seeded shuffle: ${JSON.stringify(seats.map((s) => s.holeCards))} vs ${JSON.stringify(predicted.holes)}`);
      let hand = await handOf(alice, handId);
      must(hand.stage === 'preflop' && hand.pot === 30 && hand.currentBet === 20, `preflop betting info is wrong: ${JSON.stringify(hand)}`);
      // Heads-up: dealer(=position0, Alice) is the small blind and acts first preflop.
      const actAsToAct = async (action) => {
        seats = await seatsOf(alice, id);
        hand = await handOf(alice, handId);
        const seat = seats[hand.toActPos];
        const who = seat.label === 'Alice' ? alice : bob;
        return who.post(`/Room/${id}/action/act`, { action }, { json: true });
      };
      await actAsToAct('call');
      await actAsToAct('check'); // closes preflop
      hand = await handOf(alice, handId);
      must(hand.stage === 'flop' && hand.community.split(',').length === 3, `flop was not dealt: ${JSON.stringify(hand)}`);
      const expectedFlop = predicted.deck.slice(4, 7).join(',');
      must(hand.community === expectedFlop, `flop cards do not match the seeded deck: ${hand.community} vs ${expectedFlop}`);
      await actAsToAct('check'); await actAsToAct('check');
      hand = await handOf(alice, handId);
      must(hand.stage === 'turn' && hand.community.split(',').length === 4, 'turn was not dealt');
      await actAsToAct('check'); await actAsToAct('check');
      hand = await handOf(alice, handId);
      must(hand.stage === 'river' && hand.community.split(',').length === 5, 'river was not dealt');
      await actAsToAct('check'); await actAsToAct('check');
      hand = await handOf(alice, handId);
      must(hand.stage === 'done', `hand did not reach showdown: ${JSON.stringify(hand)}`);
      seats = await seatsOf(alice, id);
      const community = hand.community.split(',');
      const results = seats.map((s) => ({ label: s.label, ...bestHand([...s.holeCards.split(','), ...community]) }));
      results.sort((a, b) => { for (let i = 0; i < 9; i++) { const d = (b.score[i] ?? -1) - (a.score[i] ?? -1); if (d) return d; } return 0; });
      must(hand.winnerLabel === results[0].label && hand.winningHandName === results[0].name,
        `showdown winner does not match the independently-evaluated best hand: server said ${hand.winnerLabel}/${hand.winningHandName}, expected ${results[0].label}/${results[0].name}`);
      const detail = await alice.get(`/Room/${id}`);
      must(/data-widget="poker"/.test(detail.html) && /src="\/widget\/poker\.mjs"/.test(detail.html), 'the table page does not embed the poker widget');

      // Round-4 rule for widget apps: also drive the real widget in a real
      // browser and confirm the server changed (folded in here rather than
      // a separate array entry, so checks.mjs still has one entry per
      // ui_instruct case). A fresh room/hand: Alice is dealer+small blind in
      // heads-up and acts first preflop, committed 10 of the 20 owed.
      const created2 = await alice.post('/Room', { name: 'Browser Table', maxSeats: '2' }, { json: true });
      const id2 = created2.body.id;
      await bob.post(`/Room/${id2}/action/join`, {}, { json: true });
      await alice.post(`/Room/${id2}/action/startHand`, {}, { json: true });
      const b = await openBrowser(`${base}/Room/${id2}`, { cookie: alice.cookie() });
      try {
        await b.until(`document.querySelectorAll('[data-seat]').length === 2`, 8000);
        await b.eval(`document.querySelector('[data-action="call"]').click()`);
        await b.until(`document.querySelector('[data-seat="0"] [data-committed]')?.textContent.includes('20')`, 8000);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally {
        await b.close();
      }
      const seats2 = await seatsOf(alice, id2);
      must(seats2.find((s) => s.label === 'Alice').committed === 20, `the browser click for "call" did not reach the server: ${JSON.stringify(seats2)}`);
      return `Room #${id}: full hand dealt, bet through pre-flop/flop/turn/river exactly per the seeded shuffle, showdown winner (${hand.winnerLabel}, ${hand.winningHandName}) matches an independent hand evaluation; Room #${id2}: a real-browser click on "call" reached the server`;
    } },

  { task: 'A user\'s profile shows their past game results and statistics',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@poker.test', 'alice123');
      const before = (await alice.get('/User/2', { json: true })).body;
      const detail = await alice.get('/User/2');
      must(/Hands Played/.test(detail.html) && /Hands Won/.test(detail.html), 'the profile does not show hands played/won');
      must(String(before.handsPlayed) !== '' && String(before.handsWon) !== '', 'stats are not present in the JSON profile');
      must(new RegExp(String(before.handsPlayed)).test(detail.html) && new RegExp(String(before.handsWon)).test(detail.html),
        'the displayed numbers do not match the stored statistics');
      return `Alice's profile shows handsPlayed=${before.handsPlayed}, handsWon=${before.handsWon}`;
    } },

  colorCheck('azure', 'midnightblue'),
];
