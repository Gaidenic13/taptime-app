// Leave, corrections, overtime & the approval center (plan Phases 10, 11, 12, 14).
import { db, insert } from "../db.js";
import { audit } from "../audit.js";
import { notify } from "./notifications.js";
import { leaveImpact } from "./staffing.js";
import { businessDays, dateTimeIso, nowIso } from "../time.js";

export const LEAVE_DEDUCTIBLE = new Set(["annual", "personal"]);

// ---------------------------------------------------------------- create
export async function requestLeave(user, { type, start_date, end_date, note }) {
  if (!type || !start_date || !end_date || end_date < start_date) {
    throw new Error("Valid type and date range required");
  }
  const days = businessDays(start_date, end_date);
  if (LEAVE_DEDUCTIBLE.has(type) && days > user.leave_balance) {
    throw new Error(`Only ${user.leave_balance} days remaining`);
  }
  const id = await insert(`
    INSERT INTO leave_requests (organization_id, user_id, type, start_date, end_date, days, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `, user.organization_id, user.id, type, start_date, end_date, days, note || "", nowIso());
  await audit({
    orgId: user.organization_id, actorId: user.id, action: "leave_request",
    entityType: "leave_request", entityId: id,
    next: { type, start_date, end_date, days },
  });
  if (user.manager_id) {
    await notify(user.organization_id, user.manager_id, "leave_submitted",
      `${user.first_name} ${user.last_name} requested leave`,
      `${type} · ${start_date} → ${end_date}`, "/approvals");
  }
  return { id, days };
}

export async function requestCorrection(user, { date, kind, requested_in, requested_out, reason }) {
  if (!date || !kind) throw new Error("date and kind required");
  const id = await insert(`
    INSERT INTO corrections (organization_id, user_id, date, kind, requested_in, requested_out, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `, user.organization_id, user.id, date, kind, requested_in || "", requested_out || "", reason || "", nowIso());
  await audit({
    orgId: user.organization_id, actorId: user.id, action: "correction_request",
    entityType: "correction", entityId: id, next: { date, kind, requested_in, requested_out },
  });
  if (user.manager_id) {
    await notify(user.organization_id, user.manager_id, "correction_submitted",
      `${user.first_name} ${user.last_name} requested an attendance correction`, `${kind} on ${date}`, "/approvals");
  }
  return id;
}

// ---------------------------------------------------------------- approval center
export async function pendingApprovals(orgId) {
  const join = (table) => db.all(`
    SELECT t.*, u.first_name, u.last_name, jr.name AS job_title
    FROM ${table} t JOIN users u ON u.id = t.user_id
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    WHERE t.organization_id = ? AND t.status = 'pending' ORDER BY t.created_at
  `, orgId);

  const leaves = [];
  for (const l of await join("leave_requests")) {
    const u = await db.get("SELECT leave_balance FROM users WHERE id = ?", l.user_id);
    leaves.push({
      ...l, balance: u.leave_balance,
      staffing_impact: await leaveImpact(orgId, l.user_id, l.start_date, l.end_date),
    });
  }

  const reviews = await db.all(`
    SELECT a.*, u.first_name, u.last_name, jr.name AS job_title, l.name AS location_name
    FROM attendance a JOIN users u ON u.id = a.user_id
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE a.organization_id = ? AND a.status = 'requires_review' ORDER BY a.date DESC
  `, orgId);

  const flags = await db.all(`
    SELECT f.*, u.first_name, u.last_name FROM attendance_flags f
    JOIN users u ON u.id = f.user_id
    WHERE f.organization_id = ? AND f.status = 'open'
      AND (f.attendance_id IS NULL OR f.attendance_id NOT IN
        (SELECT id FROM attendance WHERE status = 'requires_review'))
    ORDER BY f.created_at DESC
  `, orgId);

  const { pendingLinks } = await import("./phones.js");
  return {
    links: await pendingLinks(orgId),
    leaves,
    corrections: await join("corrections"),
    overtime: await join("overtime"),
    reviews, flags,
  };
}

export async function decide(reviewer, type, id, decision, note = "") {
  if (!["approved", "rejected", "compensated"].includes(decision)) {
    throw new Error("decision must be approved/rejected/compensated");
  }
  const tables = { leave: "leave_requests", correction: "corrections", overtime: "overtime" };
  const table = tables[type];
  if (!table) throw new Error("Unknown approval type");
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row || row.organization_id !== reviewer.organization_id || row.status !== "pending") {
    throw new Error("Request not found or already decided");
  }

  await db.tx(async (c) => {
    if (table === "overtime") {
      await c.run("UPDATE overtime SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        decision, reviewer.id, nowIso(), id);
    } else {
      await c.run(`UPDATE ${table} SET status = ?, reviewed_by = ?, reviewed_at = ?, decision_note = ? WHERE id = ?`,
        decision, reviewer.id, nowIso(), note || "", id);
    }

    if (decision === "approved" && table === "leave_requests" && LEAVE_DEDUCTIBLE.has(row.type)) {
      await c.run("UPDATE users SET leave_balance = leave_balance - ? WHERE id = ?", row.days, row.user_id);
    }
    if (decision === "approved" && table === "corrections") {
      await applyCorrection(c, reviewer, row);
    }
  });

  await audit({
    orgId: reviewer.organization_id, actorId: reviewer.id, action: `${type}_${decision}`,
    entityType: type, entityId: Number(id),
    previous: { status: "pending" }, next: { status: decision, note },
  });

  const titles = {
    leave: `Leave request ${decision}`,
    correction: `Attendance correction ${decision}`,
    overtime: `Overtime ${decision}`,
  };
  await notify(reviewer.organization_id, row.user_id, `${type}_${decision}`, titles[type], note || "",
    type === "leave" ? "/leave" : "/attendance");
}

// Corrections never silently overwrite history: the previous record is stored
// in the audit trail and the row is marked MANUAL_APPROVED (plan Phase 10).
async function applyCorrection(c, reviewer, corr) {
  // Sessions model: corrections apply to the first session of that day
  // (or create one when the day has no record at all).
  let att = await c.get(
    "SELECT * FROM attendance WHERE user_id = ? AND date = ? ORDER BY clock_in LIMIT 1",
    corr.user_id, corr.date
  );
  const previous = att ? { ...att } : null;
  if (!att) {
    const user = await c.get("SELECT * FROM users WHERE id = ?", corr.user_id);
    // A created historical record must never be an OPEN session (that would
    // block future check-ins), so a missing bound falls back to the other one.
    const inIso = dateTimeIso(corr.date, corr.requested_in || corr.requested_out);
    const outIso = dateTimeIso(corr.date, corr.requested_out || corr.requested_in);
    att = await c.get(`
      INSERT INTO attendance (organization_id, user_id, date, clock_in, clock_out,
                              clock_in_method, clock_out_method, location_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'MANUAL_APPROVED', 'MANUAL_APPROVED', ?, 'corrected', ?, ?) RETURNING *
    `, corr.organization_id, corr.user_id, corr.date, inIso, outIso, user.location_id, nowIso(), nowIso());
  } else {
    const sets = ["status = 'corrected'", "updated_at = ?"];
    const vals = [nowIso()];
    if (corr.requested_in) {
      sets.push("clock_in = ?", "clock_in_method = 'MANUAL_APPROVED'");
      vals.push(dateTimeIso(corr.date, corr.requested_in));
    }
    if (corr.requested_out) {
      sets.push("clock_out = ?", "clock_out_method = 'MANUAL_APPROVED'");
      vals.push(dateTimeIso(corr.date, corr.requested_out));
    }
    await c.run(`UPDATE attendance SET ${sets.join(", ")} WHERE id = ?`, ...vals, att.id);
  }

  await audit({
    orgId: corr.organization_id, actorId: reviewer.id, action: "attendance_corrected",
    entityType: "attendance", entityId: att.id,
    previous, next: { requested_in: corr.requested_in, requested_out: corr.requested_out },
    metadata: `correction ${corr.id}`,
  });
}

export async function resolveFlag(reviewer, flagId, note = "") {
  const f = await db.get("SELECT * FROM attendance_flags WHERE id = ?", flagId);
  if (!f || f.organization_id !== reviewer.organization_id) throw new Error("Flag not found");
  await db.run(`
    UPDATE attendance_flags SET status = 'resolved', resolved_by = ?, resolution_note = ?, resolved_at = ?
    WHERE id = ?
  `, reviewer.id, note, nowIso(), flagId);
  await audit({
    orgId: reviewer.organization_id, actorId: reviewer.id, action: "flag_resolved",
    entityType: "attendance_flag", entityId: flagId, next: { note },
  });
}
