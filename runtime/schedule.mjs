// The `every` interval format shared by the schedule checker and the server's
// timers — a leaf module (no internal imports) so `check/schedule.mjs` and
// `server.mjs` read the same rule instead of validating and parsing it twice
// (the same reason expr.mjs/spec.mjs are shared by the checker and the store).
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const EVERY_RE = /^([1-9]\d*)(s|m|h|d)$/;

export const validEvery = (s) => EVERY_RE.test(String(s ?? ''));
export const everyMs = (s) => {
  const m = EVERY_RE.exec(String(s ?? ''));
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null;
};
