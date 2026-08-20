// Critical business-logic tests (plan Phase 24). Runs on an isolated temp DB:
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

const tmpDb = path.join(os.tmpdir(), `taptime-test-${process.pid}.db`);
process.env.TAPTIME_DB = tmpDb;
process.env.NODE_ENV = "test";

const { db } = await import("../db.js");
const { hashPassword } = await import("../auth.js");
const { clockIn, clockOut, breakAction, dayStatus } = await import("../domains/attendance.js");
const { createShift, validateShift } = await import("../domains/scheduling.js");
const { createChallenge, consumeChallenge, checkpointByCode } = await import("../domains/checkpoints.js");
const { requestLeave, decide, pendingApprovals, requestCorrection } = await import("../domains/requests.js");
const { setSetting } = await import("../settings.js");
const { todayStr } = await import("../time.js");

let orgA, orgB, empA, empA2, mgrA, empB, locA, roleA;

before(() => {
  const now = new Date().toISOString();
  orgA = db.prepare("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('A','a',?,?)").run(now, now).lastInsertRowid;
  orgB = db.prepare("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('B','b',?,?)").run(now, now).lastInsertRowid;
  locA = db.prepare("INSERT INTO locations (organization_id, name) VALUES (?, 'Clinic A')").run(orgA).lastInsertRowid;
  roleA = db.prepare("INSERT INTO job_roles (organization_id, name) VALUES (?, 'Dentist')").run(orgA).lastInsertRowid;
  const pw = hashPassword("x");
  const mkUser = (org, email, role) => db.prepare(`
    INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, job_role_id, location_id)
    VALUES (?, 'T', 'User', ?, ?, ?, ?, ?)
  `).run(org, email, pw, role, roleA, locA).lastInsertRowid;
  empA = mkUser(orgA, "e@a.test", "employee");
  empA2 = mkUser(orgA, "e2@a.test", "employee");
  mgrA = mkUser(orgA, "m@a.test", "manager");
  empB = mkUser(orgB, "e@b.test", "employee");
});

after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
});

const user = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

// ---------------------------------------------------------------- attendance
test("clock in → break → clock out computes minutes and prevents bad sequences", () => {
  let s = clockIn(user(empA), { deviceKnown: true });
  assert.equal(s.status, "working");
  assert.throws(() => clockIn(user(empA), { deviceKnown: true }), /Already clocked in/);

  s = breakAction(user(empA), "start");
  assert.equal(s.status, "break");
  assert.throws(() => breakAction(user(empA), "start"), /already running/);
  s = breakAction(user(empA), "end");
  assert.equal(s.status, "working");
  assert.throws(() => breakAction(user(empA), "end"), /No break running/);

  s = clockOut(user(empA));
  assert.equal(s.status, "complete");
  assert.throws(() => clockOut(user(empA)), /Already clocked out/);
  const att = s.attendance;
  assert.equal(att.status, "completed");
  assert.ok(att.worked_minutes >= 0);
  assert.ok(att.break_minutes >= 0);
  assert.throws(() => breakAction(user(empA), "start"), /Not currently working/);
});

test("clock-out before clock-in is rejected", () => {
  assert.throws(() => clockOut(user(empA2)), /Not clocked in/);
});

test("no-shift + unknown-device clock-in is held for review and flagged", () => {
  const s = clockIn(user(empA2), { deviceKnown: false });
  assert.equal(s.status, "requires_review");
  assert.equal(s.attendance.risk_level, "high");
  const flags = db.prepare("SELECT * FROM attendance_flags WHERE user_id = ?").all(empA2);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].risk_level, "high");
});

test("require_shift_to_clock_in blocks unscheduled clock-ins when enabled", () => {
  setSetting(orgA, "require_shift_to_clock_in", true);
  assert.throws(() => clockIn(user(mgrA), { deviceKnown: true }), /no scheduled shift/);
  setSetting(orgA, "require_shift_to_clock_in", false);
});

// ---------------------------------------------------------------- scheduling
test("overlapping shifts and invalid times are rejected", () => {
  const date = "2030-01-07";
  createShift(user(mgrA), { user_id: empA, date, start_time: "08:00", end_time: "16:00", location_id: locA });
  assert.throws(
    () => createShift(user(mgrA), { user_id: empA, date, start_time: "15:00", end_time: "20:00", location_id: locA }),
    /Overlaps/
  );
  assert.throws(
    () => validateShift({ userId: empA, date, startTime: "18:00", endTime: "17:00" }),
    /end after it starts/
  );
  // Non-overlapping second shift is fine.
  createShift(user(mgrA), { user_id: empA, date, start_time: "17:00", end_time: "20:00", location_id: locA });
});

test("shifts cannot be scheduled at a location the employee is not assigned to", () => {
  const locB = db.prepare("INSERT INTO locations (organization_id, name) VALUES (?, 'Clinic A2')").run(orgA).lastInsertRowid;
  assert.throws(
    () => createShift(user(mgrA), { user_id: empA, date: "2030-01-08", start_time: "08:00", end_time: "16:00", location_id: locB }),
    /not assigned/
  );
  db.prepare("INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?)").run(empA, locB);
  createShift(user(mgrA), { user_id: empA, date: "2030-01-08", start_time: "08:00", end_time: "16:00", location_id: locB });
});

test("scheduling over approved leave is rejected", () => {
  const { id } = { id: requestLeave(user(empA), { type: "unpaid", start_date: "2030-02-03", end_date: "2030-02-04", note: "" }).id };
  decide(user(mgrA), "leave", id, "approved");
  assert.throws(
    () => createShift(user(mgrA), { user_id: empA, date: "2030-02-03", start_time: "08:00", end_time: "16:00", location_id: locA }),
    /approved leave/
  );
});

// ---------------------------------------------------------------- security
test("cross-organization access is blocked", () => {
  // Manager from org A cannot schedule org B's employee…
  assert.throws(
    () => createShift(user(mgrA), { user_id: empB, date: "2030-01-09", start_time: "08:00", end_time: "16:00" }),
    /not found/
  );
  // …and org A approvals never contain org B data.
  requestLeave(user(empB), { type: "unpaid", start_date: "2030-03-03", end_date: "2030-03-03", note: "" });
  const pending = pendingApprovals(orgA);
  assert.ok(pending.leaves.every((l) => l.user_id !== empB));
  // …and cannot decide org B's requests.
  const reqB = db.prepare("SELECT id FROM leave_requests WHERE user_id = ?").get(empB);
  assert.throws(() => decide(user(mgrA), "leave", reqB.id, "approved"), /not found/i);
});

// ---------------------------------------------------------------- challenges
test("checkpoint challenges are single-use and org-scoped", () => {
  db.prepare(`
    INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
    VALUES (?, ?, 'Door', 'QR', 'test-door')
  `).run(orgA, locA);
  const cp = checkpointByCode("test-door");
  const ch = createChallenge(cp);

  // Wrong org cannot consume.
  assert.equal(consumeChallenge(ch.token, user(empB)), null);
  // First valid consumption wins…
  const got = consumeChallenge(ch.token, user(empA));
  assert.equal(got.code, "test-door");
  // …replays fail.
  assert.equal(consumeChallenge(ch.token, user(empA)), null);
  // Unknown/garbage tokens fail.
  assert.equal(consumeChallenge("nonsense", user(empA)), null);
});

test("expired challenges are rejected", () => {
  const cp = checkpointByCode("test-door");
  const ch = createChallenge(cp);
  db.prepare("UPDATE attendance_challenges SET expires_at = ? WHERE token = ?")
    .run(new Date(Date.now() - 1000).toISOString(), ch.token);
  assert.equal(consumeChallenge(ch.token, user(empA)), null);
});

// ---------------------------------------------------------------- corrections audit
test("approved corrections update attendance and leave an audit trail", () => {
  const corrId = requestCorrection(user(empA), {
    date: "2030-01-07", kind: "missing_in", requested_in: "08:05", requested_out: "", reason: "forgot",
  });
  decide(user(mgrA), "correction", corrId, "approved");
  const att = db.prepare("SELECT * FROM attendance WHERE user_id = ? AND date = '2030-01-07'").get(empA);
  assert.equal(att.clock_in_method, "MANUAL_APPROVED");
  assert.equal(att.status, "corrected");
  const auditRow = db.prepare(
    "SELECT * FROM audit_log WHERE action = 'attendance_corrected' AND entity_id = ?"
  ).get(att.id);
  assert.ok(auditRow, "audit entry exists");
});
