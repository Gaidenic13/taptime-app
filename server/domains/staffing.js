// Dental clinic staffing intelligence (plan Phase 5).
// Compares Required (staffing_requirements) vs Scheduled (shifts) vs Present
// (attendance) per role/location/time-band, and produces gap alerts.
import { db } from "../db.js";
import { dayStatus } from "./attendance.js";
import { todayStr } from "../time.js";

const PRESENT = new Set(["working", "break", "complete"]);

// Weekday with Monday=0, matching staffing_requirements.weekday.
const weekdayOf = (dateStr) => (new Date(dateStr + "T12:00:00").getDay() + 6) % 7;

export async function coverageFor(orgId, date = todayStr(), { locationId = null } = {}) {
  const weekday = weekdayOf(date);
  const nowHM = new Date().toTimeString().slice(0, 5);
  const isToday = date === todayStr();

  const reqs = await db.all(`
    SELECT sr.*, jr.name AS role_name, l.name AS location_name
    FROM staffing_requirements sr
    JOIN job_roles jr ON jr.id = sr.job_role_id
    JOIN locations l ON l.id = sr.location_id
    WHERE sr.organization_id = ? AND sr.weekday = ? ${locationId ? "AND sr.location_id = ?" : ""}
    ORDER BY l.name, sr.start_time, jr.name
  `, ...(locationId ? [orgId, weekday, locationId] : [orgId, weekday]));

  const shifts = await db.all(`
    SELECT s.*, u.job_role_id AS user_role_id FROM shifts s JOIN users u ON u.id = s.user_id
    WHERE s.organization_id = ? AND s.date = ?
  `, orgId, date);

  const bands = [];
  for (const r of reqs) {
    const inBand = (s) =>
      s.start_time < r.end_time && r.start_time < s.end_time &&
      (s.job_role_id || s.user_role_id) === r.job_role_id &&
      (!s.location_id || s.location_id === r.location_id);
    const bandShifts = shifts.filter(inBand);
    const scheduled = bandShifts.length;
    let present = 0;
    // "Present" only meaningful while the band is current.
    const bandActive = isToday && nowHM >= r.start_time && nowHM <= r.end_time;
    if (bandActive) {
      for (const s of bandShifts) {
        if (PRESENT.has((await dayStatus(s.user_id, date)).status)) present++;
      }
    }
    bands.push({
      id: r.id, location_id: r.location_id, location: r.location_name,
      role: r.role_name, job_role_id: r.job_role_id,
      band: `${r.start_time}–${r.end_time}`, start_time: r.start_time, end_time: r.end_time,
      required: r.required_count, scheduled,
      present: bandActive ? present : null,      // null = band not currently active
      scheduled_gap: Math.max(0, r.required_count - scheduled),
      present_gap: bandActive ? Math.max(0, r.required_count - present) : 0,
    });
  }

  const alerts = bands
    .filter((b) => b.scheduled_gap > 0 || b.present_gap > 0)
    .map((b) => ({
      location: b.location, role: b.role, band: b.band,
      missing: Math.max(b.scheduled_gap, b.present_gap),
      kind: b.present_gap > 0 ? "present" : "scheduled",
      message: b.present_gap > 0
        ? `${b.present_gap} ${b.role}${b.present_gap > 1 ? "s" : ""} missing right now at ${b.location} (${b.band})`
        : `${b.scheduled_gap} ${b.role}${b.scheduled_gap > 1 ? "s" : ""} not scheduled for ${b.location} ${b.band}`,
    }));

  return { date, weekday, bands, alerts };
}

// Impact preview for leave approval (plan Phase 11): which requirement bands
// drop below target on each requested day if this person is away.
export async function leaveImpact(orgId, userId, startDate, endDate) {
  const user = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!user?.job_role_id) return [];
  const impacts = [];
  const start = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const weekday = (d.getDay() + 6) % 7;
    const reqs = await db.all(`
      SELECT sr.*, jr.name AS role_name, l.name AS location_name
      FROM staffing_requirements sr
      JOIN job_roles jr ON jr.id = sr.job_role_id
      JOIN locations l ON l.id = sr.location_id
      WHERE sr.organization_id = ? AND sr.weekday = ? AND sr.job_role_id = ?
    `, orgId, weekday, user.job_role_id);
    for (const r of reqs) {
      // Same-role colleagues scheduled that day in the band, excluding the requester.
      const others = (await db.get(`
        SELECT COUNT(*) AS n FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.organization_id = ? AND s.date = ? AND s.user_id != ?
          AND u.job_role_id = ? AND s.start_time < ? AND ? < s.end_time
          AND (s.location_id IS NULL OR s.location_id = ?)
      `, orgId, date, userId, user.job_role_id, r.end_time, r.start_time, r.location_id)).n;
      if (others < r.required_count) {
        impacts.push({
          date, location: r.location_name, role: r.role_name,
          band: `${r.start_time}–${r.end_time}`,
          remaining: others, required: r.required_count,
        });
      }
    }
  }
  return impacts;
}
