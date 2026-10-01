// Server side of the recycling game: the block is the whole rulebook (which
// bin an item belongs in, refusing a repeat drop, deciding when the game
// ends and whether it earns a badge) — the widget only renders and posts an
// {item, bin} intent, exactly the "server refuses illegal moves" contract
// round-4 asks for. "dropped" (a JSON array of already-sorted item ids,
// stored on the row) stands in for a per-session claim table: it is reset by
// the newGame transition, so "already sorted" only ever means "this
// playthrough", the same shape a real leaderboard round would have.
export default {
  async: true, // its blocks await store.*, resolve and text (docs/FORMAT.md "Plugins")
  blocks: {
    'recycle.drop': {
      summary: 'sort "item" into "bin" for the current GameSession: refuses a finished game or a repeat of the same item, otherwise grades the drop against WasteItem.correctBin, updates the running score, and finishes the game (with a badge at 5+ correct) once every item has been sorted once',
      effects: ['db.write'], requires: ['item', 'bin'],
      run: async ({ store, entity, id, step, resolve }) => {
        const session = await store.get(entity, id);
        if (session.status !== 'playing') throw new Error('This game is already over — start a new one to play again');
        const itemId = Number((await resolve({ v: step.item })).v);
        const binId = Number((await resolve({ v: step.bin })).v);
        const item = await store.get('WasteItem', itemId);
        if (!item) throw new Error('No such item');
        const bin = await store.get('Bin', binId);
        if (!bin) throw new Error('No such bin');
        const done = JSON.parse(session.dropped || '[]');
        if (done.includes(itemId)) throw new Error('That item is already sorted');
        const correct = Number(item.correctBin) === binId;
        await store.insert('Drop', { gameSession: session.id, item: itemId, bin: binId, correct: correct ? 1 : 0 });
        const total = session.total + 1;
        const correctCount = session.correct + (correct ? 1 : 0);
        const score = session.score + (correct ? 10 : 0);
        const set = { score, correct: correctCount, total, dropped: JSON.stringify([...done, itemId]) };
        let message;
        if (correct) message = `Nice! ${item.name} belongs in the ${bin.name} bin.`;
        else {
          const rightBin = await store.get('Bin', Number(item.correctBin));
          message = `Not quite — ${item.name} actually belongs in the ${rightBin.name} bin. You'll get it next time!`;
        }
        const totalItems = (await store.list('WasteItem', {})).length;
        if (total >= totalItems) {
          set.status = 'finished';
          if (correctCount >= 5) set.badge = 'Recycling Star';
        }
        await store.update(entity, id, set);
        return { message };
      },
    },
  },
  widgets: {
    recyclebin: {
      summary: 'a drag-into-bins canvas: items on a tray, bins as drop targets, live score, gentle correction on a miss, and a reward screen once the game finishes',
      client: './recyclebin.client.mjs',
    },
  },
};
