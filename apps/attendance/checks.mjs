// webgen-bench/000048 — time attendance: clock in/out, own records, admin view + stats.
import { colorCheck } from '../../verify/lib.mjs';

let attendanceId = null;

export const checks = [
  { task: 'Clock in for the start of a work shift',
    run: async ({ login, follow, rowWith, idOf, must, flashOf }) => {
      must((await login('alice@attendance.test', 'alice123')).status === 303, 'alice could not log in');
      const r = await follow('/Attendance', {});
      must(/Clocked in — your shift has started/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const open = rowWith(r.html, 'status">Open');
      must(open, `no open session on the dashboard: ${r.html.slice(0, 400)}`);
      attendanceId = idOf(r.html, 'status">Open', 'Attendance');
      return `session #${attendanceId} opened for Alice`;
    } },
  { task: 'Clock out at the end of a work shift',
    run: async ({ get, follow, must, flashOf }) => {
      const before = await get(`/Attendance/${attendanceId}`);
      must(/go\/clockOut"/.test(before.html), 'no clock-out control on the open session');
      const r = await follow(`/Attendance/${attendanceId}/go/clockOut`, {});
      must(/Clocked out at 20\d\d-.*hour\(s\) logged/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const detail = await get(`/Attendance/${attendanceId}`);
      must(/status">Closed/.test(detail.html), 'the session did not close');
      must(/<th>Hours Worked<\/th><td>\d+\.\d{2}<\/td>/.test(detail.html), `hours worked not shown: ${detail.html}`);
      must(/<th>Clock Out<\/th><td>20\d\d-/.test(detail.html), 'clock-out time not recorded');
      const again = await follow(`/Attendance/${attendanceId}/go/clockOut`, {});
      // a 400/409 from the second attempt is reported as its own page, not a thrown error here
      return 'session closed with a recorded clock-out time and derived hours worked';
    } },
  { task: "View your personal attendance record, including attendance time and any absence time",
    run: async ({ get, post, follow, rows, rowWith, must, flashOf }) => {
      const mine = await get('/Attendance');
      must(mine.status === 200, `attendance list returned ${mine.status}`);
      const all = rows(mine.html);
      must(all.length === 3, `expected 3 sessions for Alice (2 seeded + today's), got ${all.length}`);
      const day20 = rowWith(mine.html, '2026-09-20');
      must(day20 && /<td>8\.00<\/td>/.test(day20), `2026-09-20 session hours wrong: ${day20}`);
      const day21 = rowWith(mine.html, '2026-09-21');
      must(day21 && /<td>7\.75<\/td>/.test(day21), `2026-09-21 session hours wrong: ${day21}`);
      const before = await get('/Absence');
      must(rows(before.html).length === 0, "Alice already has an absence she did not report");
      const reported = await follow('/Absence', { date: '2026-09-25', reason: 'Family emergency' });
      must(/Absence recorded/.test(flashOf(reported.html)), `flash: ${flashOf(reported.html)}`);
      const mineAbsences = rows(reported.html);
      must(mineAbsences.length === 1 && /Family emergency/.test(mineAbsences[0]) && /2026-09-25/.test(mineAbsences[0]),
        `Alice's absence log: ${mineAbsences.map((r) => r.slice(0, 140))}`);
      const trySpy = rows((await get('/Attendance?employee=3')).html);
      must(trySpy.length === 3 && trySpy.every((r) => !/bob@attendance\.test/.test(r)),
        "Alice's own-scoping is not enforced against the employee filter");
      return "3 attendance sessions with derived hours (8.00, 7.75, today's); own absence reported and listed";
    } },
  { task: "View the attendance records of all employees as administrators",
    run: async ({ asGuest, login, get, rows, must }) => {
      asGuest();
      must((await login('admin@attendance.test', 'admin123')).status === 303, 'admin could not log in');
      const all = await get('/Attendance');
      must(all.status === 200, `admin attendance list returned ${all.status}`);
      const listed = rows(all.html);
      must(listed.length === 4, `expected 4 sessions across both employees, got ${listed.length}`);
      must(listed.some((r) => /alice@attendance\.test/.test(r)) && listed.some((r) => /bob@attendance\.test/.test(r)),
        'both employees are not represented in the admin view');
      const filtered = rows((await get('/Attendance?employee=2')).html);
      must(filtered.length === 3, `the employee filter did not narrow to Alice's 3 sessions, got ${filtered.length}`);
      return "admin sees all 4 sessions across Alice and Bob; the employee filter narrows";
    } },
  { task: 'Perform a statistical analysis of employee attendance',
    run: async ({ get, must }) => {
      const dash = await get('/dashboard/stats');
      must(dash.status === 200, `dashboard returned ${dash.status}`);
      must(/<b>2<\/b>Employees/.test(dash.html), `employee count card wrong: ${dash.html.slice(0, 800)}`);
      const period = await get('/dashboard/stats?from=2026-09-20&to=2026-09-21');
      must(period.status === 200, `filtered dashboard returned ${period.status}`);
      must(/<b>3<\/b>Sessions/.test(period.html), `session count over the period wrong: ${period.html.slice(0, 800)}`);
      must(/<b>23\.75<\/b>Hours logged/.test(period.html), `hours-logged card over the period wrong: ${period.html.slice(0, 800)}`);
      must(/<td>alice@attendance\.test<\/td><td>2<\/td><td>15\.75<\/td>/.test(period.html), `hours-by-employee row for Alice wrong: ${period.html}`);
      must(/<td>bob@attendance\.test<\/td><td>1<\/td><td>8\.00<\/td>/.test(period.html), `hours-by-employee row for Bob wrong: ${period.html}`);
      return 'dashboard renders without error; over 2026-09-20..21: 3 sessions, 23.75 hours, correct per-employee breakdown';
    } },
  colorCheck('papayawhip', 'darkorange'),
];
