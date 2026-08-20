// Scheduling engine (plan Phase 4) — shift CRUD with conflict validation.
import { db } from "../db.js";
import { audit } from "../audit.js";
import { notify } from "./notifications.js";
import { shiftMinutes } from "../time.js";

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

export function validateShift({ userId, date, startTime, endTime, excludeShiftId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) throw new Error("Invalid time");
  if (shiftMinutes(startTime, endTime) <= 0) throw new Error("Shift must end after it starts");
  if (shiftMinutes(startTime, endTime) > 16 * 60) throw new Error("Shift longer than 16h — check the times");

  const existing = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND date = ?").all(userId, date);
  for (const s of existing) {
    if (excludeShiftId && s.id === excludeShiftId) continue;
    if (overlaps(startTime, endTime, s.start_time, s.end_time)) {
      throw new Error(`Overlaps an existing shift (${s.start_time}–${s.end_time})`);
    }
  }
  const leave = db.prepare(`
    SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved'
      AND start_date <= ? AND end_date >= ?
  `).get(userId, date, date);
  if (leave) throw new Error("Employee is on approved leave that day");
}

export function createShift(actor, { user_id, date, start_time, end_time, location_id, job_role_id, notes }) {
  const employee = db.prepare("SELECT * FROM users WHERE id = ?").get(user_id);
  if (!employee || employee.organization_id !== actor.organization_id) throw new Error("Employee not found");

  // Location conflict: employee must be assigned to the location (primary or extra).
  if (location_id) {
    const allowed = employee.location_id === location_id ||
      db.prepare("SELECT 1 FROM employee_locations WHERE user_id = ? AND location_id = ?").get(user_id, location_id);
    if (!allowed) throw new Error("Employee is not assigned to that location");
  }

  validateShift({ userId: user_id, date, startTime: start_time, endTime: end_time });

  const info = db.prepare(`
    INSERT INTO shifts (organization_id, user_id, date, start_time, end_time, location_id, job_role_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor.organization_id, user_id, date, start_time, end_time,
    location_id || null, job_role_id || employee.job_role_id || null, notes || ""
  );
  audit({
    orgId: actor.organization_id, actorId: actor.id, action: "shift_create",
    entityType: "shift", entityId: info.lastInsertRowid,
    next: { user_id, date, start_time, end_time, location_id },
  });
  notify(actor.organization_id, user_id, "shift_created",
    `New shift: ${date} ${start_time}–${end_time}`, "", "/schedule");
  return info.lastInsertRowid;
}

export function deleteShift(actor, shiftId) {
  const shift = db.prepare("SELECT * FROM shifts WHERE id = ?").get(shiftId);
  if (!shift || shift.organization_id !== actor.organization_id) throw new Error("Shift not found");
  db.prepare("DELETE FROM shifts WHERE id = ?").run(shiftId);
  audit({
    orgId: actor.organization_id, actorId: actor.id, action: "shift_delete",
    entityType: "shift", entityId: shiftId, previous: shift,
  });
  notify(actor.organization_id, shift.user_id, "shift_removed",
    `Shift removed: ${shift.date} ${shift.start_time}–${shift.end_time}`, "", "/schedule");
}

export function weekShifts(orgId, weekStart, weekEnd, { userId = null, locationId = null, jobRoleId = null } = {}) {
  const clauses = ["s.organization_id = ?", "s.date BETWEEN ? AND ?"];
  const params = [orgId, weekStart, weekEnd];
  if (userId) { clauses.push("s.user_id = ?"); params.push(userId); }
  if (locationId) { clauses.push("s.location_id = ?"); params.push(locationId); }
  if (jobRoleId) { clauses.push("u.job_role_id = ?"); params.push(jobRoleId); }
  return db.prepare(`
    SELECT s.*, u.first_name, u.last_name, jr.name AS job_title, l.name AS location_name
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = s.location_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY s.date, s.start_time
  `).all(...params);
}
