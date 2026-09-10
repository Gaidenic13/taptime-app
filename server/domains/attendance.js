// Core attendance engine (plan Phases 6, 8, 9, 12) — SESSION MODEL.
// A person can check in and out many times a day; each in/out pair is one
// attendance session row. Daily hours = the sum of session durations. At most
// one session per person may be open at a time (enforced by a partial unique
// index). All clock events flow through here regardless of method
// (WEB/QR/NFC/KIOSK); the server is the authority for every timestamp.
import { db, insert } from "../db.js";
import { audit } from "../audit.js";
import { getSettings } from "../settings.js";
import { notifyManagers, notify } from "./notifications.js";
import {
  todayStr, nowIso, dateTimeIso, minutesBetween, shiftMinutes,
  breakMinutes, workedMinutes,
} from "../time.js";

const sessionsFor = (c, userId, date) =>
  c.all("SELECT * FROM attendance WHERE user_id = ? AND date = ? ORDER BY clock_in", userId, date);
const openSession = (c, userId) =>
  c.get("SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL", userId);
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

// Sum of net worked minutes across a day's sessions (open session counts up to now).
async function dayMinutes(c, sessions) {
  let worked = 0, breaks = 0;
  for (const s of sessions) {
    const br = await breaksFor(c, s.id);
    breaks += breakMinutes(br);
    worked += s.clock_out && s.worked_minutes != null ? s.worked_minutes : workedMinutes(s, br);
  }
  return { worked, breaks };
}

// ---------------------------------------------------------------- status
export async function dayStatus(userId, date) {
  const sessions = await sessionsFor(db, userId, date);
  const open = sessions.find((s) => !s.clock_out) || null;
  const shift = await shiftFor(db, userId, date);
  const onLeave = await leaveOn(db, userId, date);
  const brOpen = open ? await openBreak(db, open.id) : null;
  const { worked, breaks } = await dayMinutes(db, sessions);
  let settings = null;
  if (sessions.length || shift) {
    const orgId = sessions[0]?.organization_id ||
      (await db.get("SELECT organization_id FROM users WHERE id = ?", userId)).organization_id;
    settings = await getSettings(orgId);
  }

  let status = "no_shift";
  if (onLeave) status = "leave";
  else if (open?.status === "requires_review") status = "requires_review";
  else if (brOpen) status = "break";
  else if (open) status = "working";
  else if (sessions.length) status = "complete"; // checked out — may check in again
  else if (shift) {
    const grace = settings?.late_grace_min ?? 5;
    const start = new Date(dateTimeIso(date, shift.start_time));
    const end = new Date(dateTimeIso(date, shift.end_time));
    const now = new Date();
    if (now < new Date(start.getTime() + grace * 60000)) status = "upcoming";
    else if (now > end) status = "absent";
    else status = "late";
  }
  const closed = sessions.filter((s) => s.clock_out);
  return {
    status, shift, onLeave: !!onLeave,
    sessions,
    attendance: open || sessions[sessions.length - 1] || null,
    first_in: sessions[0]?.clock_in || null,
    last_out: open ? null : (closed[closed.length - 1]?.clock_out || null),
    worked_min: worked,
    break_min: breaks,
  };
}

// ---------------------------------------------------------------- risk (Phase 8)
// Multi-signal evaluation. Shift-window signals only apply to the FIRST session
// of the day — re-entering after lunch is normal, not "very late".
function assessClockIn({ shift, settings, method, viaCheckpoint, deviceKnown, geo, location, firstSession, orgUsesShifts }) {
  const signals = [];

  if (firstSession) {
    if (!shift) {
      // "No shift" only means something in clinics that actually schedule
      // shifts — a minimal-setup clinic that just scans is never penalized.
      if (orgUsesShifts) signals.push("no_shift");
    } else {
      const start = new Date(dateTimeIso(todayStr(), shift.start_time));
      const deltaMin = Math.round((Date.now() - start.getTime()) / 60000);
      if (deltaMin < -settings.clock_in_early_min) signals.push("too_early");
      if (deltaMin > settings.clock_in_late_flag_min) signals.push("very_late");
    }
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

// ---------------------------------------------------------------- check in
export async function clockIn(user, {
  method = "WEB", locationId = null, geo = null, viaCheckpoint = false, deviceKnown = true,
} = {}) {
  const orgId = user.organization_id;
  const settings = await getSettings(orgId);
  const date = todayStr();
  const shift = await shiftFor(db, user.id, date);
  const priorSessions = await sessionsFor(db, user.id, date);

  if (settings.require_shift_to_clock_in && !shift && priorSessions.length === 0) {
    throw new Error("You have no scheduled shift today — contact your manager");
  }
  if (await leaveOn(db, user.id, date)) {
    throw new Error("You are on approved leave today");
  }

  const locId = locationId || shift?.location_id || user.location_id;
  const location = locId ? await db.get("SELECT * FROM locations WHERE id = ?", locId) : null;
  const orgUsesShifts = !!shift ||
    !!(await db.get("SELECT id FROM shifts WHERE organization_id = ? LIMIT 1", orgId));
  const { level, signals } = assessClockIn({
    shift, settings, method, viaCheckpoint, deviceKnown, geo, location,
    firstSession: priorSessions.length === 0, orgUsesShifts,
  });

  const status = level === "high" && settings.high_risk_action === "review" ? "requires_review" : "working";

  // Transaction + the partial unique index make a double check-in impossible (Phase 22).
  let attId;
  try {
    attId = await db.tx(async (c) => {
      if (await openSession(c, user.id)) throw new Error("Already checked in");
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
    if (/UNIQUE|duplicate key/i.test(String(e.message))) throw new Error("Already checked in");
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
    next: { method, location_id: locId, risk: level, signals, session: priorSessions.length + 1 },
  });
  return dayStatus(user.id, date);
}

// ---------------------------------------------------------------- check out
export async function clockOut(user, { method = "WEB", locationId = null } = {}) {
  const orgId = user.organization_id;
  const settings = await getSettings(orgId);
  const date = todayStr();

  const result = await db.tx(async (c) => {
    const att = await openSession(c, user.id);
    if (!att) throw new Error("Not checked in");
    const now = nowIso();
    const open = await openBreak(c, att.id);
    if (open) await c.run("UPDATE breaks SET ended_at = ? WHERE id = ?", now, open.id);

    const breaks = await breaksFor(c, att.id);
    const brMin = breakMinutes(breaks, now);
    const sessionWorked = Math.max(0, minutesBetween(att.clock_in, now) - brMin);

    const newStatus = att.status === "requires_review" ? "requires_review" : "completed";
    await c.run(`
      UPDATE attendance SET clock_out = ?, clock_out_method = ?, status = ?,
        worked_minutes = ?, break_minutes = ?, updated_at = ?
      WHERE id = ?
    `, now, method, newStatus, sessionWorked, brMin, now, att.id);

    // Overtime: compare the DAY total (all sessions) against the scheduled shift.
    const sessions = await sessionsFor(c, user.id, att.date);
    const { worked: dayTotal } = await dayMinutes(c, sessions);
    const shift = att.shift_id ? await c.get("SELECT * FROM shifts WHERE id = ?", att.shift_id) : null;
    const scheduled = shift ? shiftMinutes(shift.start_time, shift.end_time) : null;
    const overtime = scheduled != null ? Math.max(0, dayTotal - scheduled) : 0;
    if (overtime >= settings.overtime_threshold_min) {
      const existing = await c.get(
        "SELECT id, status FROM overtime WHERE user_id = ? AND date = ?", user.id, att.date
      );
      if (existing?.status === "pending") {
        await c.run("UPDATE overtime SET minutes = ? WHERE id = ?", overtime, existing.id);
      } else if (!existing) {
        await c.run(`
          INSERT INTO overtime (organization_id, user_id, date, minutes, status, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `, orgId, user.id, att.date, overtime, now);
      }
    }
    return { att, sessionWorked, brMin, outLocation: locationId };
  });

  // Impossible transition check: check-out from another location too soon (Phase 8.6).
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
    next: { method, worked_minutes: result.sessionWorked },
  });
  return dayStatus(user.id, date);
}

// ---------------------------------------------------------------- breaks (Phase 9)
export async function breakAction(user, action) {
  const date = todayStr();
  await db.tx(async (c) => {
    const att = await openSession(c, user.id);
    if (!att) throw new Error("Not currently working");
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
// One-gesture attendance: a scan checks you in if you're out, out if you're in.
// A scan within 2 minutes of checking in is treated as an accidental double
// tap. There is no daily limit — scan as many times as you come and go.
export async function tapToggle(user, { method = "NFC", locationId = null, geo = null, deviceKnown = true } = {}) {
  const open = await openSession(db, user.id);
  if (!open) {
    return {
      did: "in",
      today: await clockIn(user, { method, locationId, geo, viaCheckpoint: true, deviceKnown }),
    };
  }
  if (minutesBetween(open.clock_in, nowIso()) < 2) {
    return { did: "in_recent", today: await dayStatus(user.id, todayStr()) };
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
