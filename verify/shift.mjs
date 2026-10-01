// Preload that moves the wall clock: SHIFT_DAYS=3650 NODE_OPTIONS="--import ./verify/shift.mjs" node verify/run.mjs --dated
// Every node process (verify and the app servers it spawns inherit NODE_OPTIONS) sees `new Date()` and
// `Date.now()` that many days ahead. An acceptance check that only passes today fails here.
const offset = Number(process.env.SHIFT_DAYS || 0) * 864e5;
if (offset) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...args) { if (args.length === 0) super(Real.now() + offset); else super(...args); }
    static now() { return Real.now() + offset; }
  };
}
