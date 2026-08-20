// Reporting (plan Phase 17): attendance register, leave usage, staffing coverage.
// All numbers derive from authoritative backend data (persisted worked_minutes
// where available, recomputed otherwise).
import { db } from "../db.js";
import {
  todayStr, dateTimeIso, minutesBetween, shiftMinutes, breakMinutes, workedMinutes, addDays,
} from "../time.js";
import { getSettings } from "../settings.js";

const breaksFor = (attId) => db.all("SELECT * FROM breaks WHERE attendance_id = ?", attId);

export async function attendanceReport(orgId, month, { locationId = null, jobRoleId = null, userId = null } = {}) {
  const settings = await getSettings(orgId);
  let users = await db.all(`
    SELECT u.*, jr.name AS job_title FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    WHERE u.organization_id = ? AND u.active = 1 ORDER BY u.last_name
  `, orgId);
  if (locationId) users = users.filter((u) => u.location_id === locationId);
  if (jobRoleId) users = users.filter((u) => u.job_role_id === jobRoleId);
  if (userId) users = users.filter((u) => u.id === userId);

  const rows = [];
  for (const u of users) {
    const shifts = await db.all("SELECT * FROM shifts WHERE user_id = ? AND date LIKE ?", u.id, `${month}%`);
    const atts = await db.all("SELECT * FROM attendance WHERE user_id = ? AND date LIKE ?", u.id, `${month}%`);
    const scheduled = shifts.reduce((s, x) => s + shiftMinutes(x.start_time, x.end_time), 0);
    const scheduledPast = shifts.filter((x) => x.date < todayStr())
      .reduce((s, x) => s + shiftMinutes(x.start_time, x.end_time), 0);
    let worked = 0, brTotal = 0, late = 0;
    const attByDate = {};
    for (const a of atts) {
      attByDate[a.date] = a;
      if (a.clock_out) {
        worked += a.worked_minutes ?? workedMinutes(a, await breaksFor(a.id));
        brTotal += a.break_minutes ?? breakMinutes(await breaksFor(a.id));
      }
    }
    for (const s of shifts) {
      const a = attByDate[s.date];
      if (a?.clock_in &&
          minutesBetween(dateTimeIso(s.date, s.start_time), a.clock_in) > settings.late_grace_min) late++;
    }
    let absent = 0;
    for (const s of shifts) {
      if (s.date >= todayStr() || attByDate[s.date]) continue;
      const onLeave = await db.get(`
        SELECT 1 AS x FROM leave_requests WHERE user_id = ? AND status = 'approved'
        AND start_date <= ? AND end_date >= ?
      `, u.id, s.date, s.date);
      if (!onLeave) absent++;
    }
    const otMin = (await db.get(
      "SELECT COALESCE(SUM(minutes),0) AS m FROM overtime WHERE user_id = ? AND date LIKE ? AND status = 'approved'",
      u.id, `${month}%`
    )).m;
    const leaveDays = (await db.get(`
      SELECT COALESCE(SUM(days),0) AS d FROM leave_requests
      WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?
    `, u.id, `${month}-31`, `${month}-01`)).d;
    rows.push({
      id: u.id, name: `${u.first_name} ${u.last_name}`, job_title: u.job_title || "—",
      scheduled_min: scheduled, worked_min: worked, break_min: brTotal,
      missing_min: Math.max(0, scheduledPast - worked),
      overtime_min: otMin, leave_days: leaveDays, late_days: late, absent_days: absent,
    });
  }
  return rows;
}

export async function leaveReport(orgId, year) {
  const users = await db.all(`
    SELECT u.*, jr.name AS job_title, d.name AS department FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.organization_id = ? AND u.active = 1 ORDER BY u.last_name
  `, orgId);
  const rows = [];
  for (const u of users) {
    const byType = await db.all(`
      SELECT type, SUM(days) AS days FROM leave_requests
      WHERE user_id = ? AND status = 'approved' AND start_date LIKE ? GROUP BY type
    `, u.id, `${year}%`);
    const used = byType.reduce((s, t) => s + t.days, 0);
    rows.push({
      id: u.id, name: `${u.first_name} ${u.last_name}`,
      job_title: u.job_title || "—", department: u.department || "—",
      used, remaining: u.leave_balance,
      by_type: Object.fromEntries(byType.map((t) => [t.type, t.days])),
    });
  }
  return rows;
}

// Staffing coverage history: for each day in range, required vs scheduled per band.
export async function staffingReport(orgId, startDate, endDate) {
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const weekday = (new Date(d + "T12:00:00").getDay() + 6) % 7;
    const reqs = await db.all(`
      SELECT sr.*, jr.name AS role_name, l.name AS location_name
      FROM staffing_requirements sr
      JOIN job_roles jr ON jr.id = sr.job_role_id
      JOIN locations l ON l.id = sr.location_id
      WHERE sr.organization_id = ? AND sr.weekday = ?
    `, orgId, weekday);
    for (const r of reqs) {
      const scheduled = (await db.get(`
        SELECT COUNT(*) AS n FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.organization_id = ? AND s.date = ? AND u.job_role_id = ?
          AND s.start_time < ? AND ? < s.end_time
          AND (s.location_id IS NULL OR s.location_id = ?)
      `, orgId, d, r.job_role_id, r.end_time, r.start_time, r.location_id)).n;
      out.push({
        date: d, location: r.location_name, role: r.role_name,
        band: `${r.start_time}–${r.end_time}`,
        required: r.required_count, scheduled, gap: Math.max(0, r.required_count - scheduled),
      });
    }
  }
  return out;
}
