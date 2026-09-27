// App-local plugin: the real domain logic of this app — scoring a student profile
// against a training provider's criteria. Plain expressions can compare two text
// fields for equality, but they cannot rank an ordinal scale ("a bachelor's degree
// satisfies a minimum of associate's") — that needs real code, kept small and pure.
//
//   function  matchScore(sLoc, sField, sInterest, sQual, pLoc, pField, pFocus, pMinQual)
//             0-100: 30 for a matching location, 30 for the same field of study,
//             20 for the same career interest/focus, 20 when the student's
//             qualification meets or exceeds the provider's minimum.
const QUAL_RANK = { highschool: 1, associate: 2, bachelor: 3, master: 4, phd: 5 };
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const TEXTY = new Set(['text', 'any']);

export default {
  functions: {
    matchScore: {
      arity: 8,
      kind: (ks) => {
        for (const k of ks) if (!TEXTY.has(k)) throw new Error(`matchScore() needs text-like criteria, got ${k}`);
        return 'number';
      },
      run: ([sLoc, sField, sInterest, sQual, pLoc, pField, pFocus, pMinQual]) => {
        let score = 0;
        if (sLoc && pLoc && norm(sLoc) === norm(pLoc)) score += 30;
        if (sField && pField && norm(sField) === norm(pField)) score += 30;
        if (sInterest && pFocus && norm(sInterest) === norm(pFocus)) score += 20;
        const sr = QUAL_RANK[norm(sQual)] || 0, pr = QUAL_RANK[norm(pMinQual)] || 0;
        if (pr > 0 && sr >= pr) score += 20;
        return score;
      },
    },
  },
};
