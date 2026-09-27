// App-local plugin: the two pieces of real domain logic in this app.
//
//   function  discType(q1, q2, q3, q4)   a tiny DISC-style personality classifier:
//             the name of whichever of the four 1-5 answers scored highest
//             (ties keep the earliest dimension) — an "argmax with a label",
//             which the expression algebra's max(a, b) (two numbers in, a
//             number out) cannot express.
//   function  suitability(goalArea, profileType, specialty, preferredClientType)
//             0-100: 60 for a shared goal area, 40 for a personality type the
//             coach prefers — plain equality, but combined into one score.
const DIMENSIONS = ['Dominance', 'Influence', 'Steadiness', 'Conscientiousness'];
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const TEXTY = new Set(['text', 'any']);
const NUMY = new Set(['number', 'money', 'any']);

export default {
  functions: {
    discType: {
      arity: 4,
      kind: (ks) => { for (const k of ks) if (!NUMY.has(k)) throw new Error(`discType() needs numbers, got ${k}`); return 'text'; },
      run: (scores) => {
        let best = 0;
        for (let i = 1; i < scores.length; i++) if (Number(scores[i]) > Number(scores[best])) best = i;
        return DIMENSIONS[best];
      },
    },
    suitability: {
      arity: 4,
      kind: (ks) => { for (const k of ks) if (!TEXTY.has(k)) throw new Error(`suitability() needs text-like criteria, got ${k}`); return 'number'; },
      run: ([goalArea, profileType, specialty, preferredClientType]) => {
        let score = 0;
        if (goalArea && specialty && norm(goalArea) === norm(specialty)) score += 60;
        if (profileType && preferredClientType && norm(profileType) === norm(preferredClientType)) score += 40;
        return score;
      },
    },
  },
};
