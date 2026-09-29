// The one clock. Everything in the delivery path that needs the time or a timer takes a
// `clock` = { now(), setTimer(fn, ms) -> handle, clear(handle) }; the tests hand in a fake one
// with advance(ms). This is the only module that reads the wall clock for deliveries.
/** @type {import('./types.d.ts').Clock} */
export const systemClock = {
  now: () => Date.now(),
  // Unref'd: a pending retry never keeps the process alive by itself.
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clear: (handle) => clearTimeout(handle),
};

/** The clock of an options bag: `clock`, else the system one with an overriding `now` (the older option). */
/** @param {{ clock?: import('./types.d.ts').Clock, now?: () => number }} [opts] */
export const resolveClock = (opts = {}) => opts.clock ?? (opts.now ? { ...systemClock, now: opts.now } : systemClock);
