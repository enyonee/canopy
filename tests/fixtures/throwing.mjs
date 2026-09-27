// A function whose static kind() passes the checker but whose run() throws
// for one particular input — used to exercise the one runtime path the
// checker cannot make unreachable: a rule expression that throws instead of
// returning true/false. See tests/interp.test.mjs.
export default {
  functions: {
    boom: { arity: 1, kind: () => 'bool', run: (a) => { if (a[0] === 13) throw new Error('unlucky'); return a[0] > 0; } },
  },
};
