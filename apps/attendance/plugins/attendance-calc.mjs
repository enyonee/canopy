// App-local plugin: the one piece of real domain logic this app needs — the
// duration of a clock-in/clock-out session. The core expression algebra has no
// time arithmetic (only calendar-day math via days()/addDays()), so "hours
// worked" is a plugin function over the two `time` timestamps, reused as a
// `money`-kind derived field (major units = hours, two decimals) so the
// existing rendering/aggregation for money fields (including dashboard sums
// over derived fields) applies to it unchanged.
//
//   function  hoursBetween(later, earlier)   hours between two timestamps, 2dp; null if either is missing
const TIME_KINDS = new Set(['time', 'date', 'any']);

export default {
  functions: {
    hoursBetween: {
      arity: 2,
      kind: (ks) => {
        for (const k of ks) if (!TIME_KINDS.has(k)) throw new Error(`hoursBetween() needs timestamps, got ${k}`);
        return 'money';
      },
      run: ([later, earlier]) => {
        if (later == null || earlier == null) return null;
        const ms = Date.parse(later) - Date.parse(earlier);
        if (Number.isNaN(ms)) return null;
        return Math.round((ms / 3600000) * 100) / 100;
      },
    },
  },
};
