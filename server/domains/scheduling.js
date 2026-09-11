// Scheduling engine (plan Phase 4) — shift CRUD with conflict validation.
import { db, isPg } from "../db.js";
import { audit } from "../audit.js";
import { notify } from "./notifications.js";
import { shiftMinutes, addDays, mondayOf } from "../time.js";

const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2100
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

export async function validateShift({ userId, date, startTime, endTime, excludeShiftId = null }, executor = db) {
  if (!validDate(date)) throw new Error("Invalid date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) throw new Error("Invalid time");
  if (shiftMinutes(startTime, endTime) <= 0) throw new Error("Shift must end after it starts");
  if (shiftMinutes(startTime, endTime) > 16 * 60) throw new Error("Shift longer than 16h — check the times");

  const existing = await executor.all("SELECT * FROM shifts WHERE user_id = ? AND date = ?", userId, date);
  for (const s of existing) {
    if (excludeShiftId && s.id === excludeShiftId) continue;
    if (overlaps(startTime, endTime, s.start_time, s.end_time)) {
      throw new Error(`Overlaps an existing shift (${s.start_time}–${s.end_time})`);
    }
  }
  const leave = await executor.get(`
    SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved'
      AND start_date <= ? AND end_date >= ?
  `, userId, date, date);
  if (leave) throw new Error("Employee is on approved leave that day");
}

async function checkEmployee(actor, shift, executor) {
  const employee = await executor.get("SELECT * FROM users WHERE id = ? AND organization_id = ? AND active = 1", shift.user_id, actor.organization_id);
  if (!employee) throw new Error("Active employee not found");
  if (shift.location_id) {
    const location = await executor.get("SELECT id FROM locations WHERE id = ? AND organization_id = ? AND active = 1", shift.location_id, actor.organization_id);
    const assigned = employee.location_id === shift.location_id || await executor.get("SELECT 1 AS x FROM employee_locations WHERE user_id = ? AND location_id = ?", shift.user_id, shift.location_id);
    if (!location || !assigned) throw new Error("Employee is not assigned to that active location");
  }
  if (shift.job_role_id && !await executor.get("SELECT id FROM job_roles WHERE id = ? AND organization_id = ? AND active = 1", shift.job_role_id, actor.organization_id)) throw new Error("Job role not found");
  return employee;
}

async function writeShift(actor, shift, employee, executor) {
  const { user_id, date, start_time, end_time, location_id, job_role_id, notes } = shift;
  const { id } = await executor.get(`INSERT INTO shifts (organization_id, user_id, date, start_time, end_time, location_id, job_role_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, actor.organization_id, user_id, date, start_time, end_time,
    location_id || null, job_role_id || employee.job_role_id || null, notes || "");
  await audit({ orgId: actor.organization_id, actorId: actor.id, action: "shift_create", entityType: "shift", entityId: id,
    next: { user_id, date, start_time, end_time, location_id } }, executor);
  await notify(actor.organization_id, user_id, "shift_created", `New shift: ${date} ${start_time}–${end_time}`, "", "/schedule", executor);
  return id;
}

async function lockSchedule(actor, executor) {
  // Serialize schedule creation within a clinic on Postgres; SQLite's transaction locks writes.
  if (isPg) await executor.get("SELECT id FROM organizations WHERE id = ? FOR UPDATE", actor.organization_id);
}

export async function createShift(actor, shift) {
  return db.tx(async (tx) => {
    await lockSchedule(actor, tx);
    const employee = await checkEmployee(actor, shift, tx);
    await validateShift({ userId: shift.user_id, date: shift.date, startTime: shift.start_time, endTime: shift.end_time }, tx);
    return writeShift(actor, shift, employee, tx);
  });
}

export async function copyWeek(actor, body) {
  const { source_week, target_week } = body;
  if (!validDate(source_week) || !validDate(target_week) || mondayOf(source_week) !== source_week || mondayOf(target_week) !== target_week || source_week === target_week) {
    throw new Error("Choose two different weeks starting on Monday");
  }
  const clauses = ["s.organization_id = ?", "s.date BETWEEN ? AND ?"], params = [actor.organization_id, source_week, addDays(source_week, 6)];
  for (const [key, column] of [["location_id", "s.location_id"], ["job_role_id", "u.job_role_id"]]) {
    if (body[key] != null && body[key] !== "") {
      if (!Number.isSafeInteger(body[key]) || body[key] < 1) throw new Error(`Invalid ${key}`);
      clauses.push(`${column} = ?`); params.push(body[key]);
    }
  }
  return db.tx(async (tx) => {
    await lockSchedule(actor, tx);
    const source = await tx.all(`SELECT s.*, u.first_name, u.last_name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE ${clauses.join(" AND ")} ORDER BY s.date, s.start_time LIMIT 501`, ...params);
    if (source.length > 500) throw new Error("Select a location or role to copy at most 500 shifts");
    const days = Math.round((new Date(`${target_week}T12:00:00Z`) - new Date(`${source_week}T12:00:00Z`)) / 86400000);
    const rows = [], pending = [];
    for (const original of source) {
      const shift = { ...original, date: addDays(original.date, days) };
      const row = { name: `${original.first_name} ${original.last_name}`, date: shift.date, start_time: shift.start_time, end_time: shift.end_time, status: "ready" };
      try {
        const employee = await checkEmployee(actor, shift, tx);
        const existing = await tx.get("SELECT * FROM shifts WHERE user_id = ? AND date = ? AND start_time = ?", shift.user_id, shift.date, shift.start_time);
        if (existing && existing.end_time === shift.end_time && existing.location_id === shift.location_id && existing.job_role_id === shift.job_role_id && existing.notes === shift.notes) row.status = "duplicate";
        else {
          await validateShift({ userId: shift.user_id, date: shift.date, startTime: shift.start_time, endTime: shift.end_time }, tx);
          // Also reject any overlap within the copied source itself.
          if (pending.some((p) => p.shift.user_id === shift.user_id && p.shift.date === shift.date && overlaps(p.shift.start_time, p.shift.end_time, shift.start_time, shift.end_time))) throw new Error("Copied shifts overlap each other");
          pending.push({ shift, employee });
        }
      } catch (e) { row.status = "conflict"; row.reason = e.message; }
      rows.push(row);
    }
    const conflicts = rows.filter((r) => r.status === "conflict").length;
    let created = 0;
    if (body.apply === true && !conflicts) {
      for (const { shift, employee } of pending) { await writeShift(actor, shift, employee, tx); created++; }
    }
    return { rows, conflicts, ready: pending.length, skipped: rows.filter((r) => r.status === "duplicate").length, created, applied: body.apply === true && !conflicts };
  });
}

export async function deleteShift(actor, shiftId) {
  const shift = await db.get("SELECT * FROM shifts WHERE id = ?", shiftId);
  if (!shift || shift.organization_id !== actor.organization_id) throw new Error("Shift not found");
  await db.run("DELETE FROM shifts WHERE id = ?", shiftId);
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "shift_delete",
    entityType: "shift", entityId: shiftId, previous: shift,
  });
  await notify(actor.organization_id, shift.user_id, "shift_removed",
    `Shift removed: ${shift.date} ${shift.start_time}–${shift.end_time}`, "", "/schedule");
}

export async function weekShifts(orgId, weekStart, weekEnd, { userId = null, locationId = null, jobRoleId = null } = {}) {
  const clauses = ["s.organization_id = ?", "s.date BETWEEN ? AND ?"];
  const params = [orgId, weekStart, weekEnd];
  if (userId) { clauses.push("s.user_id = ?"); params.push(userId); }
  if (locationId) { clauses.push("s.location_id = ?"); params.push(locationId); }
  if (jobRoleId) { clauses.push("u.job_role_id = ?"); params.push(jobRoleId); }
  return db.all(`
    SELECT s.*, u.first_name, u.last_name, jr.name AS job_title, l.name AS location_name
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = s.location_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY s.date, s.start_time
  `, ...params);
}
