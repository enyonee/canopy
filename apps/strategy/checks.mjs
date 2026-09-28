// Acceptance checks for webgen-bench/000011 (strategy), one per ui_instruct
// case in order, the last being the colour check. Resource accrual is a real
// /schedule tick (docs/FORMAT.md Round-4): checks trigger it by hand as an
// admin (POST /schedule/tick/run) instead of waiting on the clock, and
// predict the exact resulting numbers from the same formula app.json's
// schedule step uses — the "deterministic randomness" pattern used
// throughout this batch, applied here to a plain (non-random) accrual rule.
import { colorCheck } from '../../verify/lib.mjs';

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
  return { get, post, login };
}

let uniq = 0;
async function registerPlayer(base, name) {
  const email = `${name.toLowerCase()}${Date.now()}${uniq++}@realms.test`;
  const client = makeClient(base);
  const res = await client.post('/register', { email, password: 'password1', name });
  if (res.status !== 303) throw new Error(`registration failed for ${name}: ${res.status} ${res.html.slice(0, 200)}`);
  const me = (await client.get('/list/base', { json: true })).body.rows[0];
  return { client, email, id: me.id };
}

// Mirrors app.json's "tick" schedule exactly (see its own steps): base +
// city level + workers + double workers for the assigned resource + the
// player's race bonus for that resource.
function predictTick(state, resource) {
  const bonusField = `${resource}Bonus`;
  const raceBonus = state.race ? state.race[bonusField] || 0 : 0;
  const base = resource === 'gold' ? 10 : 5;
  const assignedBonus = state.assignedTask === resource ? state.workers * 2 : 0;
  return base + state.cityLevel * 3 + state.workers + assignedBonus + raceBonus;
}

const RACES = { Humans: 1, Dragonborns: 2, Elves: 3, Dwarfs: 4 };

export const checks = [
  { task: 'Choosing each race in turn shows that race\'s own attributes and confirms the selection',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Racer');
      for (const [name, raceId] of Object.entries(RACES)) {
        const chosen = await client.post(`/Race/${raceId}/action/choose`, {}, { json: true });
        must(chosen.status === 200 && chosen.body.ok, `choosing ${name} failed: ${JSON.stringify(chosen.body)}`);
        must(chosen.body.row.name === name, `chose race id ${raceId} but got attributes for ${chosen.body.row.name}`);
        must(new RegExp(name).test(chosen.body.flash), `no confirmation naming ${name}: "${chosen.body.flash}"`);
        const attrs = await client.get('/Race');
        must(new RegExp(name).test(attrs.html), `${name}'s row (with its attributes) is not listed on the Choose Race page`);
        const me = (await client.get('/list/base', { json: true })).body.rows[0];
        must(String(me.race) === String(raceId), `Base page does not reflect the chosen race ${name}: ${JSON.stringify(me)}`);
      }
      return `Player #${id} selected all 4 races in turn (Humans, Dragonborns, Elves, Dwarfs), each confirmed with its own attributes and reflected on the Base page`;
    } },

  { task: 'On the base page, allocating resources to upgrade the city deducts them and shows the upgrade; resources also accrue via the schedule tick',
    run: async ({ base, must }) => {
      const admin = makeClient(base);
      await admin.login('admin@realms.test', 'admin123');
      const { client, id } = await registerPlayer(base, 'Builder');
      const before = (await client.get('/list/base', { json: true })).body.rows[0];
      must(before.cityLevel === 1 && before.gold === 500 && before.iron === 200 && before.wood === 200 && before.wheat === 200,
        `fresh player does not start with the expected defaults: ${JSON.stringify(before)}`);
      const upgraded = await client.post(`/User/${id}/action/upgradeCity`, {}, { json: true });
      must(upgraded.status === 200 && upgraded.body.ok, `city upgrade failed: ${JSON.stringify(upgraded.body)}`);
      const after1 = upgraded.body.row;
      must(after1.cityLevel === 2 && after1.gold === 400 && after1.iron === 150 && after1.wood === 170 && after1.wheat === 170,
        `resources/city level after upgrading do not match the expected cost: ${JSON.stringify(after1)}`);
      must(/level 2/.test(upgraded.body.flash), `no upgrade confirmation naming the new level: "${upgraded.body.flash}"`);
      const ticked = await admin.post('/schedule/tick/run', {}, { json: true });
      must(ticked.status === 200 && ticked.body.ok, `an admin could not run the schedule tick: ${JSON.stringify(ticked.body)}`);
      const after2 = (await client.get('/list/base', { json: true })).body.rows[0];
      const state = { cityLevel: after1.cityLevel, workers: after1.workers, assignedTask: after1.assignedTask, race: null };
      must(after2.gold === after1.gold + predictTick(state, 'gold'), `gold after the tick is ${after2.gold}, expected ${after1.gold + predictTick(state, 'gold')}`);
      must(after2.iron === after1.iron + predictTick(state, 'iron'), `iron after the tick is ${after2.iron}, expected ${after1.iron + predictTick(state, 'iron')}`);
      return `Player #${id}: upgraded city to level 2 (100/50/30/30 deducted), then a schedule tick accrued exactly the formula's own predicted amounts`;
    } },

  { task: 'The ranking page lists players sorted by rank',
    run: async ({ base, must }) => {
      const weak = await registerPlayer(base, 'Weakling');
      const strong = await registerPlayer(base, 'Champion');
      await strong.client.post(`/User/${strong.id}/action/trainSoldier`, {}, { json: true });
      await strong.client.post(`/User/${strong.id}/action/trainSoldier`, {}, { json: true });
      const ranking = (await weak.client.get('/list/ranking', { json: true })).body.rows;
      must(ranking.length >= 2, 'ranking does not list multiple players');
      for (let i = 0; i < ranking.length - 1; i++) must(ranking[i].points >= ranking[i + 1].points, `ranking is not sorted by points: row ${i} (${ranking[i].points}) < row ${i + 1} (${ranking[i + 1].points})`);
      const champ = ranking.find((r) => r.id === strong.id);
      const weakling = ranking.find((r) => r.id === weak.id);
      must(champ && weakling && ranking.indexOf(champ) < ranking.indexOf(weakling), 'the player with more soldiers (higher points) is not ranked above the one with fewer');
      must(champ.points === champ.cityLevel * 100 + champ.soldiers * 5 + champ.workers, `points do not match the stated formula: ${JSON.stringify(champ)}`);
      return `Ranking lists ${ranking.length} players sorted by points descending; Champion (2 extra soldiers) outranks Weakling exactly as the points formula predicts`;
    } },

  { task: 'Purchasing a limited-stock store item spends resources, grants the item, and removes it from the store once sold out',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Shopper');
      const before = (await client.get('/list/base', { json: true })).body.rows[0];
      const item = (await client.get('/StoreItem', { json: true })).body.rows.find((r) => r.name === 'Recruit a worker');
      must(item && item.stock === 2, `test setup: expected "Recruit a worker" seeded with stock 2, got ${JSON.stringify(item)}`);
      const bought1 = await client.post(`/StoreItem/${item.id}/action/buy`, {}, { json: true });
      must(bought1.status === 200 && bought1.body.ok && bought1.body.row.stock === 1, `first purchase did not decrement stock: ${JSON.stringify(bought1.body)}`);
      const me1 = (await client.get('/list/base', { json: true })).body.rows[0];
      must(me1.workers === before.workers + 1 && me1.gold === before.gold - item.costGold && me1.wheat === before.wheat - item.costWheat,
        `resources were not deducted / worker not granted: ${JSON.stringify(me1)} vs before ${JSON.stringify(before)}`);
      const bought2 = await client.post(`/StoreItem/${item.id}/action/buy`, {}, { json: true });
      must(bought2.status === 200 && bought2.body.row.stock === 0, `second purchase did not exhaust stock: ${JSON.stringify(bought2.body)}`);
      const storeAfter = await client.get('/StoreItem');
      must(!new RegExp(`Recruit a worker`).test(storeAfter.html), 'the sold-out item is still listed in the store');
      const bought3 = await client.post(`/StoreItem/${item.id}/action/buy`, {}, { json: true });
      must(bought3.status === 400, `buying an out-of-stock item was not refused: ${bought3.status}`);
      return `Player #${id} bought "Recruit a worker" twice (+2 workers, resources deducted both times), exhausting its stock of 2 — it then disappears from the Store page and a third purchase is refused`;
    } },

  { task: 'The train page trains a worker or a soldier, showing the new count and the resources it consumed',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Trainer');
      const before = (await client.get('/list/train', { json: true })).body.rows[0];
      const worker = await client.post(`/User/${id}/action/trainWorker`, {}, { json: true });
      must(worker.status === 200 && worker.body.row.workers === before.workers + 1 && worker.body.row.gold === before.gold - 50 && worker.body.row.wheat === before.wheat - 20,
        `training a worker did not update the count and consume resources correctly: ${JSON.stringify(worker.body.row)}`);
      must(/worker/i.test(worker.body.flash), `no training confirmation: "${worker.body.flash}"`);
      const soldier = await client.post(`/User/${id}/action/trainSoldier`, {}, { json: true });
      must(soldier.status === 200 && soldier.body.row.soldiers === 1 && soldier.body.row.gold === worker.body.row.gold - 100 && soldier.body.row.iron === before.iron - 50,
        `training a soldier did not update the count and consume resources correctly: ${JSON.stringify(soldier.body.row)}`);
      return `Player #${id}: trained +1 worker (-50 gold/-20 wheat) and +1 soldier (-100 gold/-50 iron), both counts and costs confirmed`;
    } },

  { task: 'The workers page assigns a task to the workforce, acknowledging it and deducting the reassignment cost',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Foreman');
      const before = (await client.get('/list/workers', { json: true })).body.rows[0];
      must(before.assignedTask === 'gold', `test setup: expected the default task to be gold, got ${before.assignedTask}`);
      const assigned = await client.post(`/User/${id}/action/assignIron`, {}, { json: true });
      must(assigned.status === 200 && assigned.body.ok && assigned.body.row.assignedTask === 'iron', `assigning workers to iron failed: ${JSON.stringify(assigned.body)}`);
      must(/iron/.test(assigned.body.flash), `no acknowledgment naming the new task: "${assigned.body.flash}"`);
      must(assigned.body.row.gold === before.gold - 20, `reassigning workers did not deduct its cost: ${assigned.body.row.gold} vs ${before.gold - 20}`);
      return `Player #${id}: workers reassigned from gold to iron, acknowledged, 20 gold deducted for the reassignment`;
    } },

  { task: 'The upgrades page upgrades a soldier, showing improved stats and the resources it spent',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Armorer');
      const before = (await client.get('/list/upgrades', { json: true })).body.rows[0];
      const upgraded = await client.post(`/User/${id}/action/upgradeSoldier`, {}, { json: true });
      must(upgraded.status === 200 && upgraded.body.ok, `soldier upgrade failed: ${JSON.stringify(upgraded.body)}`);
      const row = upgraded.body.row;
      must(row.attack === before.attack + 5 && row.defense === before.defense + 5, `soldier stats were not improved: ${JSON.stringify(row)}`);
      must(row.gold === before.gold - 200 && row.iron === before.iron - 100, `the upgrade did not spend the stated resources: ${JSON.stringify(row)}`);
      must(/attack/.test(upgraded.body.flash) && /defense/.test(upgraded.body.flash), `no confirmation of the improved stats: "${upgraded.body.flash}"`);
      return `Player #${id}: soldiers upgraded (+5 attack, +5 defense) for 200 gold and 100 iron`;
    } },

  { task: 'The bank page deposits gold, increasing the bank balance and decreasing gold on hand',
    run: async ({ base, must }) => {
      const { client, id } = await registerPlayer(base, 'Banker');
      const before = (await client.get('/list/bank', { json: true })).body.rows[0];
      must(before.bankGold === 0, `test setup: expected a fresh bank balance of 0, got ${before.bankGold}`);
      const deposited = await client.post(`/User/${id}/action/depositGold`, {}, { json: true });
      must(deposited.status === 200 && deposited.body.ok, `deposit failed: ${JSON.stringify(deposited.body)}`);
      must(deposited.body.row.bankGold === 100 && deposited.body.row.gold === before.gold - 100,
        `deposit did not move gold correctly: ${JSON.stringify(deposited.body.row)} vs before ${JSON.stringify(before)}`);
      must(/100/.test(deposited.body.flash), `no confirmation of the deposited amount: "${deposited.body.flash}"`);
      const html = await client.get('/list/bank');
      must(new RegExp(String(deposited.body.row.bankGold)).test(html.html), 'the bank page does not show the updated balance');
      return `Player #${id}: deposited 100 gold, bank balance now 100, on-hand gold reduced accordingly, shown on the Bank page`;
    } },

  colorCheck('seashell', 'crimson'),
];
