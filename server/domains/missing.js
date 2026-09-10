import { db } from "../db.js";
import { audit } from "../audit.js";
import { getSettings } from "../settings.js";
import { notifyManagers, notify } from "./notifications.js";
import { nowIso, dateTimeIso, minutesBetween, breakMinutes, hhmm } from "../time.js";

// Forgotten clock-outs. An open session nobody closed is never worth anything
// on its own: once it passes the clinic's closing time or the maximum session
// length it is closed with ZERO credited minutes and status 'missing_out'.
// A manager (or the member, via a correction request) supplies the real time.
// The origin stays visible in clock_out_method (AUTO → AUTO_FIXED) so the
// "forgotten this month" counters keep working after the fix.

const FORGOT_METHODS = ["AUTO", "AUTO_FIXED"];

// The moment an open session stops being believable.
function cutoffFor(att, settings) {
  const start = new Date(att.clock_in).getTime();
  const candidates = [start + Math.max(1, Number(settings.max_session_hours) || 12) * 3600000];
  if (/^\d{2}:\d{2}$/.test(settings.closing_time || "")) {
    const close = new Date(dateTimeIso(att.date, settings.closing_time)).getTime();
    if (close > start) candidates.push(close);
  }
  return new Date(Math.min(...candidates)).toISOString();
}

export async function sweepOpenSessions(orgId) {
  const open = await db.all(
    "SELECT * FROM attendance WHERE organization_id = ? AND clock_out IS NULL", orgId
  );
  if (!open.length) return 0;
  const settings = await getSettings(orgId);
  const now = nowIso();
  let closed = 0;
  for (const att of open) {
    const cutoff = cutoffFor(att, settings);
    if (cutoff > now) continue;
    await db.run("UPDATE breaks SET ended_at = ? WHERE attendance_id = ? AND ended_at IS NULL", cutoff, att.id);
    const breaks = await db.all("SELECT * FROM breaks WHERE attendance_id = ?", att.id);
    const r = await db.run(`
      UPDATE attendance SET clock_out = ?, clock_out_method = 'AUTO', status = 'missing_out',
        worked_minutes = 0, break_minutes = ?, updated_at = ?
      WHERE id = ? AND clock_out IS NULL
    `, cutoff, breakMinutes(breaks, cutoff), now, att.id);
    if (!r.changes) continue;
    closed++;
    const user = await db.get("SELECT first_name, last_name FROM users WHERE id = ?", att.user_id);
    await audit({
      orgId, actorId: null, action: "clock_out_missing", entityType: "attendance", entityId: att.id,
      next: { closed_at: cutoff, credited_minutes: 0 },
    });
    await notify(orgId, att.user_id, "missing_out",
      `Your clock-out on ${att.date} is missing`,
      "Those hours don't count until your manager confirms when you left — tell them the time.", "/");
    await notifyManagers(orgId, "missing_out",
      `${user.first_name} ${user.last_name} never clocked out on ${att.date}`,
      `Clocked in at ${hhmm(att.clock_in)} — set the real time under Approvals`, "/approvals");
  }
  return closed;
}

// Every clinic, for the scheduled cron.
export async function sweepAll() {
  const orgs = await db.all("SELECT DISTINCT organization_id AS id FROM attendance WHERE clock_out IS NULL");
  let n = 0;
  for (const o of orgs) n += await sweepOpenSessions(o.id);
  return n;
}

// Manager sets when the person really left — for a session still open or
// one the sweep closed. Credits the hours, keeps the "forgotten" origin.
export async function setClockOut(reviewer, attendanceId, time) {
  const att = await db.get("SELECT * FROM attendance WHERE id = ?", attendanceId);
  if (!att || att.organization_id !== reviewer.organization_id) throw new Error("Record not found");
  if (att.clock_out && att.status !== "missing_out") throw new Error("This session already has a clock-out");
  if (!/^\d{2}:\d{2}$/.test(String(time || ""))) throw new Error("Time must be HH:MM");
  const out = dateTimeIso(att.date, time);
  if (out <= att.clock_in) throw new Error(`Clock-out must be after the clock-in (${hhmm(att.clock_in)})`);
  if (out > nowIso()) throw new Error("Clock-out can't be in the future");

  await db.run("UPDATE breaks SET ended_at = ? WHERE attendance_id = ? AND ended_at IS NULL", out, att.id);
  const breaks = await db.all("SELECT * FROM breaks WHERE attendance_id = ?", att.id);
  const brMin = breakMinutes(breaks, out);
  const worked = Math.max(0, minutesBetween(att.clock_in, out) - brMin);
  const method = att.clock_out_method === "AUTO" ? "AUTO_FIXED" : "MANUAL_APPROVED";
  await db.run(`
    UPDATE attendance SET clock_out = ?, clock_out_method = ?, status = 'corrected',
      worked_minutes = ?, break_minutes = ?, updated_at = ?
    WHERE id = ?
  `, out, method, worked, brMin, nowIso(), att.id);
  // The member's own "I left at" request, if any, is answered by this.
  await db.run(`
    UPDATE corrections SET status = 'approved', reviewed_by = ?, reviewed_at = ?, decision_note = 'Clock-out set by manager'
    WHERE user_id = ? AND date = ? AND status = 'pending' AND kind = 'missing_out'
  `, reviewer.id, nowIso(), att.user_id, att.date);
  await audit({
    orgId: att.organization_id, actorId: reviewer.id, action: "clock_out_set",
    entityType: "attendance", entityId: att.id,
    previous: { clock_out: att.clock_out, status: att.status, worked_minutes: att.worked_minutes },
    next: { clock_out: out, worked_minutes: worked },
  });
  await notify(att.organization_id, att.user_id, "clock_out_set",
    `Your clock-out on ${att.date} was set to ${time}`, `${worked} minutes credited`, "/");
  return { worked_minutes: worked };
}

// Manager decides the missing session earns nothing.
export async function rejectMissingOut(reviewer, attendanceId) {
  const att = await db.get("SELECT * FROM attendance WHERE id = ?", attendanceId);
  if (!att || att.organization_id !== reviewer.organization_id) throw new Error("Record not found");
  if (att.status !== "missing_out") throw new Error("This session isn't a missing clock-out");
  await db.run("UPDATE attendance SET status = 'rejected', worked_minutes = 0, updated_at = ? WHERE id = ?", nowIso(), att.id);
  await audit({
    orgId: att.organization_id, actorId: reviewer.id, action: "missing_out_rejected",
    entityType: "attendance", entityId: att.id, previous: { status: "missing_out" }, next: { status: "rejected" },
  });
  await notify(att.organization_id, att.user_id, "missing_out_rejected",
    `No hours counted for ${att.date}`, "Your clock-out was missing and no time was confirmed.", "/");
  return { ok: true };
}

// Unresolved missing clock-outs of one member (what their scan page shows),
// with whether they already asked for a correction.
export async function missingFor(userId) {
  const rows = await db.all(`
    SELECT id, date, clock_in, clock_out FROM attendance
    WHERE user_id = ? AND status = 'missing_out' ORDER BY date DESC LIMIT 10
  `, userId);
  for (const r of rows) {
    const c = await db.get(
      "SELECT id FROM corrections WHERE user_id = ? AND date = ? AND status = 'pending'", userId, r.date
    );
    r.correction_pending = !!c;
  }
  return rows;
}

// Approval-center list.
export async function pendingMissing(orgId) {
  return db.all(`
    SELECT a.id, a.date, a.clock_in, a.clock_out AS closed_at, a.device_id, u.id AS user_id, u.first_name, u.last_name,
      cp.name AS entrance,
      (SELECT s.end_time FROM shifts s WHERE s.user_id = a.user_id AND s.date = a.date ORDER BY s.start_time LIMIT 1) AS shift_end,
      (SELECT c.requested_out FROM corrections c WHERE c.user_id = a.user_id AND c.date = a.date AND c.status = 'pending' ORDER BY c.created_at DESC LIMIT 1) AS asked_out
    FROM attendance a JOIN users u ON u.id = a.user_id
    LEFT JOIN attendance_checkpoints cp ON cp.id = a.checkpoint_id
    WHERE a.organization_id = ? AND a.status = 'missing_out' ORDER BY a.date DESC, a.clock_in
  `, orgId);
}

// Open sessions a manager may want to close by hand (end of day).
export async function stillIn(orgId) {
  const settings = await getSettings(orgId);
  const rows = await db.all(`
    SELECT a.id, a.date, a.clock_in, u.first_name, u.last_name FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.organization_id = ? AND a.clock_out IS NULL ORDER BY a.clock_in
  `, orgId);
  const now = Date.now();
  const closing = /^\d{2}:\d{2}$/.test(settings.closing_time || "") ? settings.closing_time : null;
  const nearClosing = closing && now >= new Date(dateTimeIso(rows[0]?.date || "2000-01-01", closing)).getTime() - 30 * 60000;
  return {
    closing_time: closing,
    rows: rows.filter((r) => nearClosing || now - new Date(r.clock_in).getTime() > 6 * 3600000)
      .map((r) => ({ ...r, name: `${r.first_name} ${r.last_name}` })),
  };
}

// user_id → number of forgotten clock-outs in a month (fixed or not).
export async function forgotCounts(orgId, month) {
  const rows = await db.all(`
    SELECT user_id, COUNT(*) AS n FROM attendance
    WHERE organization_id = ? AND date LIKE ? AND clock_out_method IN (${FORGOT_METHODS.map(() => "?").join(",")})
    GROUP BY user_id
  `, orgId, `${month}%`, ...FORGOT_METHODS);
  return Object.fromEntries(rows.map((r) => [r.user_id, r.n]));
}
