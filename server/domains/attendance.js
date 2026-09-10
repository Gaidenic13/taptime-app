// Core attendance engine (plan Phases 6, 8, 9, 12).
// All clock events flow through here regardless of method (WEB/QR/NFC/KIOSK).
// The server is the authority: timestamps, validation, risk and status are
// computed here inside transactions — never trusted from the client.
import { db, insert } from "../db.js";
import { audit } from "../audit.js";
import { getSettings } from "../settings.js";
import { notifyManagers, notify } from "./notifications.js";
import {
  todayStr, nowIso, dateTimeIso, minutesBetween, shiftMinutes,
  breakMinutes, workedMinutes,
} from "../time.js";

const attToday = (c, userId, date) =>
  c.get("SELECT * FROM attendance WHERE user_id = ? AND date = ?", userId, date);
const breaksFor = (c, attId) =>
  c.all("SELECT * FROM breaks WHERE attendance_id = ? ORDER BY start", attId);
const openBreak = (c, attId) =>
  c.get("SELECT * FROM breaks WHERE attendance_id = ? AND ended_at IS NULL", attId);
const shiftFor = (c, userId, date) =>
  c.get("SELECT * FROM shifts WHERE user_id = ? AND date = ? ORDER BY start_time LIMIT 1", userId, date);
const leaveOn = (c, userId, date) =>
  c.get(
    "SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?",
    userId, date, date
  );

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ---------------------------------------------------------------- status
export async function dayStatus(userId, date) {
  const att = await attToday(db, userId, date);
  const shift = await shiftFor(db, userId, date);
  const onLeave = await leaveOn(db, userId, date);
  const breaks = att ? await breaksFor(db, att.id) : [];
  const open = att ? await openBreak(db, att.id) : null;
  let settings = null;
  if (att || shift) {
    const orgId = att?.organization_id ||
      (await db.get("SELECT organization_id FROM users WHERE id = ?", userId)).organization_id;
    settings = await getSettings(orgId);
  }

  let status = "no_shift";
  if (onLeave) status = "leave";
  else if (att?.status === "requires_review") status = "requires_review";
  else if (att?.clock_out) status = "complete";
  else if (open) status = "break";
  else if (att?.clock_in) status = "working";
  else if (shift) {
    const grace = settings?.late_grace_min ?? 5;
    const start = new Date(dateTimeIso(date, shift.start_time));
    const end = new Date(dateTimeIso(date, shift.end_time));
    const now = new Date();
    if (now < new Date(start.getTime() + grace * 60000)) status = "upcoming";
    else if (now > end) status = "absent";
    else status = "late";
  }
  return {
    status, shift, onLeave: !!onLeave,
    attendance: att || null, breaks,
    worked_min: att ? workedMinutes(att, breaks) : 0,
    break_min: att ? breakMinutes(breaks) : 0,
  };
}

// ---------------------------------------------------------------- risk (Phase 8)
// Multi-signal evaluation. Returns { level, signals } — never a hard block by
// itself; what happens to HIGH events is configurable (settings.high_risk_action).
function assessClockIn({ shift, settings, method, viaCheckpoint, deviceKnown, geo, location }) {
  const signals = [];

  if (!shift) signals.push("no_shift");
  else {
    const start = new Date(dateTimeIso(todayStr(), shift.start_time));
    const deltaMin = Math.round((Date.now() - start.getTime()) / 60000);
    if (deltaMin < -settings.clock_in_early_min) signals.push("too_early");
    if (deltaMin > settings.clock_in_late_flag_min) signals.push("very_late");
  }

  if (!deviceKnown && method !== "KIOSK") signals.push("unknown_device");

  if (settings.location_mode !== "disabled" && location?.latitude != null && location?.longitude != null) {
    if (geo?.latitude != null && geo?.longitude != null) {
      const dist = haversineMeters(geo.latitude, geo.longitude, location.latitude, location.longitude);
      const ok = dist <= (location.attendance_radius_meters || 150) + (geo.accuracy || 0);
      if (!ok) signals.push(`location_mismatch:${dist}m`);
    } else if (settings.location_mode === "required") {
      signals.push("location_unavailable");
    } else if (settings.location_mode === "preferred") {
      signals.push("location_unavailable_soft");
    }
  }

  const hard = signals.filter((s) => !s.endsWith("_soft"));
  const mismatch = signals.some((s) => s.startsWith("location_mismatch"));
  let level = "low";
  if (mismatch || (hard.includes("no_shift") && hard.includes("unknown_device")) || hard.length >= 3) level = "high";
  else if (hard.length >= 1 && !(hard.length === 1 && hard[0] === "unknown_device")) level = "medium";
  // A checkpoint tap is positive evidence — soften one level.
  if (viaCheckpoint && level === "medium" && !mismatch) level = "low";
  return { level, signals };
}

async function flag(orgId, { attendanceId = null, userId, kind, detail = "", risk = "medium" }) {
  const id = await insert(`
    INSERT INTO attendance_flags (organization_id, attendance_id, user_id, kind, detail, risk_level, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, orgId, attendanceId, userId, kind, detail, risk, nowIso());
  if (risk === "high") {
    const u = await db.get("SELECT first_name, last_name FROM users WHERE id = ?", userId);
    await notifyManagers(orgId, "high_risk_attendance",
      `High-risk attendance event — ${u.first_name} ${u.last_name}`,
      `${kind} ${detail}`.trim(), "/approvals");
  }
  return id;
}

// ---------------------------------------------------------------- clock in
export async function clockIn(user, {
  method = "WEB", locationId = null, geo = null, viaCheckpoint = false, deviceKnown = true,
} = {}) {
  const orgId = user.organization_id;
  const settings = await getSettings(orgId);
  const date = todayStr();
  const shift = await shiftFor(db, user.id, date);

  if (settings.require_shift_to_clock_in && !shift) {
    throw new Error("You have no scheduled shift today — contact your manager");
  }
  if (await leaveOn(db, user.id, date)) {
    throw new Error("You are on approved leave today");
  }

  const locId = locationId || shift?.location_id || user.location_id;
  const location = locId ? await db.get("SELECT * FROM locations WHERE id = ?", locId) : null;
  const { level, signals } = assessClockIn({
    shift, settings, method, viaCheckpoint, deviceKnown, geo, location,
  });

  const status = level === "high" && settings.high_risk_action === "review" ? "requires_review" : "working";

  // Transaction + UNIQUE(user_id, date) make double clock-in impossible (Phase 22).
  let attId;
  try {
    attId = await db.tx(async (c) => {
      if (await attToday(c, user.id, date)) throw new Error("Already clocked in today");
      const row = await c.get(`
        INSERT INTO attendance
          (organization_id, user_id, shift_id, date, clock_in, clock_in_method, location_id,
           status, risk_level, risk_signals, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `,
        orgId, user.id, shift?.id || null, date, nowIso(), method, locId,
        status, level, JSON.stringify(signals), nowIso(), nowIso()
      );
      return row.id;
    });
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e.message))) throw new Error("Already clocked in today");
    throw e;
  }

  if (level !== "low" && (level === "high" || settings.high_risk_action !== "accept")) {
    await flag(orgId, {
      attendanceId: attId, userId: user.id,
      kind: signals[0] || "risk", detail: signals.join(", "), risk: level,
    });
  }
  await audit({
    orgId, actorId: user.id, action: "clock_in", entityType: "attendance", entityId: attId,
    next: { method, location_id: locId, risk: level, signals },
  });
  return dayStatus(user.id, date);
}

// ---------------------------------------------------------------- clock out
export async function clockOut(user, { method = "WEB", locationId = null } = {}) {
  const orgId = user.organization_id;
  const settings = await getSettings(orgId);
  const date = todayStr();

  const result = await db.tx(async (c) => {
    const att = await attToday(c, user.id, date);
    if (!att?.clock_in) throw new Error("Not clocked in");
    if (att.clock_out) throw new Error("Already clocked out");
    const now = nowIso();
    const open = await openBreak(c, att.id);
    if (open) await c.run("UPDATE breaks SET ended_at = ? WHERE id = ?", now, open.id);

    const breaks = await breaksFor(c, att.id);
    const brMin = breakMinutes(breaks, now);
    const worked = Math.max(0, minutesBetween(att.clock_in, now) - brMin);
    const shift = att.shift_id ? await c.get("SELECT * FROM shifts WHERE id = ?", att.shift_id) : null;
    const scheduled = shift ? shiftMinutes(shift.start_time, shift.end_time) : null;
    const overtime = scheduled != null ? Math.max(0, worked - scheduled) : 0;

    const newStatus = att.status === "requires_review" ? "requires_review" : "completed";
    await c.run(`
      UPDATE attendance SET clock_out = ?, clock_out_method = ?, status = ?,
        worked_minutes = ?, break_minutes = ?, overtime_minutes = ?, updated_at = ?
      WHERE id = ?
    `, now, method, newStatus, worked, brMin, overtime, now, att.id);

    if (overtime >= settings.overtime_threshold_min) {
      await c.run(`
        INSERT INTO overtime (organization_id, user_id, date, minutes, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `, orgId, user.id, date, overtime, now);
    }
    return { att, worked, brMin, overtime, outLocation: locationId };
  });

  // Impossible transition check: clock-out from another location too soon (Phase 8.6).
  if (result.outLocation && result.att.location_id &&
      result.outLocation !== result.att.location_id &&
      minutesBetween(result.att.clock_in, nowIso()) < 20) {
    await flag(orgId, {
      attendanceId: result.att.id, userId: user.id, kind: "impossible_transition",
      detail: `in at location ${result.att.location_id}, out at ${result.outLocation} within 20min`,
      risk: "high",
    });
  }
  if (result.brMin > settings.break_max_min) {
    await flag(orgId, {
      attendanceId: result.att.id, userId: user.id, kind: "long_break",
      detail: `${result.brMin} min of breaks`, risk: "medium",
    });
  }

  await audit({
    orgId, actorId: user.id, action: "clock_out", entityType: "attendance", entityId: result.att.id,
    next: { method, worked_minutes: result.worked, overtime_minutes: result.overtime },
  });
  return dayStatus(user.id, date);
}

// ---------------------------------------------------------------- breaks (Phase 9)
export async function breakAction(user, action) {
  const date = todayStr();
  await db.tx(async (c) => {
    const att = await attToday(c, user.id, date);
    if (!att?.clock_in || att.clock_out) throw new Error("Not currently working");
    const open = await openBreak(c, att.id);
    if (action === "start") {
      if (open) throw new Error("Break already running");
      await c.run("INSERT INTO breaks (attendance_id, start) VALUES (?, ?)", att.id, nowIso());
    } else {
      if (!open) throw new Error("No break running");
      await c.run("UPDATE breaks SET ended_at = ? WHERE id = ?", nowIso(), open.id);
    }
  });
  await audit({ orgId: user.organization_id, actorId: user.id, action: `break_${action}` });
  return dayStatus(user.id, date);
}

// ---------------------------------------------------------------- tap toggle
// One-gesture attendance for checkpoints: the server decides whether a tap is
// an "in" or an "out" from current state. A tap within 2 minutes of clocking
// in is treated as an accidental double tap, not a clock-out.
export async function tapToggle(user, { method = "NFC", locationId = null, geo = null, deviceKnown = true } = {}) {
  const date = todayStr();
  const att = await attToday(db, user.id, date);
  if (!att) {
    return {
      did: "in",
      today: await clockIn(user, { method, locationId, geo, viaCheckpoint: true, deviceKnown }),
    };
  }
  if (att.clock_out) return { did: "done", today: await dayStatus(user.id, date) };
  if (minutesBetween(att.clock_in, nowIso()) < 2) {
    return { did: "in_recent", today: await dayStatus(user.id, date) };
  }
  return { did: "out", today: await clockOut(user, { method, locationId }) };
}

// ---------------------------------------------------------------- review queue
export async function resolveReview(reviewer, attendanceId, decision, note = "") {
  const att = await db.get("SELECT * FROM attendance WHERE id = ?", attendanceId);
  if (!att || att.organization_id !== reviewer.organization_id) throw new Error("Record not found");
  if (att.status !== "requires_review") throw new Error("Record is not awaiting review");

  const newStatus = decision === "approved" ? (att.clock_out ? "completed" : "working") : "rejected";
  await db.run("UPDATE attendance SET status = ?, updated_at = ? WHERE id = ?", newStatus, nowIso(), att.id);
  await db.run(`
    UPDATE attendance_flags SET status = 'resolved', resolved_by = ?, resolution_note = ?, resolved_at = ?
    WHERE attendance_id = ? AND status = 'open'
  `, reviewer.id, note, nowIso(), att.id);

  await audit({
    orgId: att.organization_id, actorId: reviewer.id, action: `attendance_review_${decision}`,
    entityType: "attendance", entityId: att.id,
    previous: { status: att.status }, next: { status: newStatus, note },
  });
  await notify(att.organization_id, att.user_id, "attendance_review",
    decision === "approved" ? "Your attendance was verified" : "An attendance record was rejected",
    note, "/attendance");
}
