// Server side of WordWise. One real piece of domain logic — vocab.grade —
// shared by all five quiz kinds behind a single global action: it is the
// authority the widgets answer to (a widget "never writes storage itself";
// grading a submitted answer against the stored word is exactly the kind of
// rule the round-4 notes ask to keep server-side). No block is needed for
// the waiting-room avatar pick or its tiny game: setting an avatar is a
// plain field write through the core edit route, and the game keeps no
// score worth a server referee (see NOTES.md).
const answerKey = (word, kind, type) => {
  if (kind === 'flashcard') return null; // self-reported, nothing to compare
  if (kind === 'matching') return String(word[type === 'antonym' ? 'antonym' : 'synonym'] || '').trim().toLowerCase();
  return String(word.term || '').trim().toLowerCase(); // fillblank / unjumble / crossword all guess the term itself
};

export default {
  blocks: {
    'vocab.grade': {
      summary: 'grade a submitted quiz attempt ("kind", "wordSet", "answers" as a JSON array of {wordId, value} or {wordId, type, value} for matching, or {wordId, knew} for flashcard) against the stored Word rows, and record the result as an Attempt',
      effects: ['db.write'], requires: ['kind', 'wordSet', 'answers'],
      run: ({ store, step, resolve }) => {
        const kind = String(resolve({ v: step.kind }).v);
        if (!['matching', 'fillblank', 'unjumble', 'crossword', 'flashcard'].includes(kind)) throw new Error('unknown quiz kind');
        const wordSet = Number(resolve({ v: step.wordSet }).v);
        const raw = resolve({ v: step.answers }).v;
        let answers;
        try { answers = JSON.parse(raw); } catch { throw new Error('answers must be valid JSON'); }
        if (!Array.isArray(answers) || !answers.length) throw new Error('answers must be a non-empty list');
        let score = 0;
        for (const a of answers) {
          const word = store.get('Word', a.wordId);
          if (!word || Number(word.wordSet) !== wordSet) throw new Error('an answer refers to a word outside this word set');
          if (kind === 'flashcard') { if (a.knew) score++; continue; }
          const expected = answerKey(word, kind, a.type);
          const got = String(a.value || '').trim().toLowerCase();
          if (expected && got === expected) score++;
        }
        const total = answers.length;
        const id = store.insert('Attempt', { kind, wordSet, score, total });
        return { id, score, total };
      },
    },
  },
  widgets: {
    vocabquiz: {
      summary: 'one of five vocabulary activities (matching / fillblank / unjumble / crossword / flashcard, chosen by the "kind" prop) over this week\'s words, graded server-side on submit',
      client: './quiz.client.mjs', props: ['kind'],
    },
    waitroom: {
      summary: 'an avatar picker for the single simulated visitor, plus a tiny deterministic click-to-win game',
      client: './waitroom.client.mjs',
    },
  },
};
