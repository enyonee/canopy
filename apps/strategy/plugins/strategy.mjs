// Server side of the strategy app. Most gameplay (upgrade city, train,
// assign a worker task, deposit gold, buy a store item) is plain
// db.adjust/db.update steps in app.json — no block needed. The two things
// that genuinely need real code live here: choosing a race sets a field on
// a DIFFERENT row than the action runs on (db.update has no entity/id
// override — only db.adjust does), and a battle is a formula over two rows
// plus two kinds of side effects (Report, Message).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sameUser = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);

export default {
  async: true, // its blocks await store.*, resolve and text (docs/FORMAT.md "Plugins")
  blocks: {
    // `own` (docs/FORMAT.md) scopes a CHILD entity's ref-to-User field; it
    // has no way to say "only the row's own id equals the session user" for
    // the User entity acting on itself, so every User-scoped action below
    // opens with this guard instead of trusting the role-level "do:<name>"
    // grant alone (which does not vary per row).
    'strategy.requireSelf': {
      summary: 'refuses unless the signed-in user is the row this action runs on',
      effects: [], requires: [],
      run: async ({ id, user }) => { if (!user || !sameUser(user.id, id)) throw new Error('You can only manage your own city'); return {}; },
    },
    'strategy.chooseRace': {
      summary: 'the current user adopts the Race row this action runs on',
      effects: ['db.write'], requires: [],
      run: async ({ store, id, user }) => { await store.update('User', user.id, { race: id }); return {}; },
    },
    // A formula-resolved battle: soldiers x attack/defense rating, each side
    // jittered +/-20% by a seed derived from both sides' ids and current
    // gold (so it is deterministic for a given state, not Math.random()),
    // the winner looting a share of the loser's gold. Writes a Report for
    // both sides and a Message to the defender — "messages and reports
    // rows" from the brief.
    'strategy.attack': {
      summary: 'the current user attacks the User row this action runs on; the higher (soldiers x rating, jittered) side wins and loots some gold',
      effects: ['db.write'], requires: [],
      run: async ({ store, entity, id, user }) => {
        const defender = await store.get(entity, id);
        const attacker = await store.get(entity, user.id);
        if (sameUser(defender.id, attacker.id)) throw new Error('You cannot attack yourself');
        if (!attacker.race || !defender.race) throw new Error('Both sides need to have chosen a race first');
        const rnd = mulberry32(Number(attacker.id) * 97 + Number(defender.id) * 13 + attacker.gold + defender.gold);
        const attackPower = attacker.soldiers * attacker.attack * (0.8 + rnd() * 0.4);
        const defensePower = defender.soldiers * defender.defense * (0.8 + rnd() * 0.4);
        const attackerWins = attackPower > defensePower;
        const loot = attackerWins ? Math.min(Math.round(defender.gold * 0.1), defender.gold) : 0;
        if (attackerWins && loot > 0) {
          await store.update(entity, defender.id, { gold: defender.gold - loot });
          await store.update(entity, attacker.id, { gold: attacker.gold + loot });
        }
        const summary = attackerWins
          ? `${attacker.name} defeated ${defender.name} (power ${Math.round(attackPower)} vs ${Math.round(defensePower)}) and looted ${loot} gold`
          : `${attacker.name} attacked ${defender.name} and lost (power ${Math.round(attackPower)} vs ${Math.round(defensePower)})`;
        await store.insert('Report', { user: attacker.id, summary });
        await store.insert('Report', { user: defender.id, summary });
        await store.insert('Message', { toUser: defender.id, fromUser: attacker.id, subject: 'You were attacked!', body: summary });
        return {};
      },
    },
  },
};
