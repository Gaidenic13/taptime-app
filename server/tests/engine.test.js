// Critical business-logic tests (plan Phase 24). Runs on an isolated temp
// SQLite DB by default; set DATABASE_URL to run the same suite against
// PostgreSQL.  Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

const tmpDb = path.join(os.tmpdir(), `taptime-test-${process.pid}.db`);
process.env.TAPTIME_DB = tmpDb;
process.env.NODE_ENV = "test";

const { db, insert, isPg } = await import("../db.js");
const { hashPassword } = await import("../auth.js");
const { clockIn, clockOut, breakAction, tapToggle } = await import("../domains/attendance.js");
const { createShift, validateShift } = await import("../domains/scheduling.js");
const { createChallenge, consumeChallenge, checkpointByCode } = await import("../domains/checkpoints.js");
const { requestLeave, decide, pendingApprovals, requestCorrection } = await import("../domains/requests.js");
const { setSetting } = await import("../settings.js");

let orgA, orgB, empA, empA2, mgrA, empB, locA, roleA;

before(async () => {
  const now = new Date().toISOString();
  orgA = await insert("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('A','a',?,?)", now, now);
  orgB = await insert("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('B','b',?,?)", now, now);
  locA = await insert("INSERT INTO locations (organization_id, name) VALUES (?, 'Clinic A')", orgA);
  roleA = await insert("INSERT INTO job_roles (organization_id, name) VALUES (?, 'Dentist')", orgA);
  const pw = hashPassword("x");
  const mkUser = (org, email, role) => insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, job_role_id, location_id)
    VALUES (?, 'T', 'User', ?, ?, ?, ?, ?)
  `, org, email, pw, role, roleA, locA);
  empA = await mkUser(orgA, "e@a.test", "employee");
  empA2 = await mkUser(orgA, "e2@a.test", "employee");
  mgrA = await mkUser(orgA, "m@a.test", "manager");
  empB = await mkUser(orgB, "e@b.test", "employee");
});

after(async () => {
  await db.close();
  if (!isPg) {
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmpDb + s); } catch { /* gone */ } }
  }
});

const user = (id) => db.get("SELECT * FROM users WHERE id = ?", id);

// ---------------------------------------------------------------- attendance
test("check in → break → check out, then a SECOND session the same day", async () => {
  let s = await clockIn(await user(empA), { deviceKnown: true });
  assert.equal(s.status, "working");
  await assert.rejects(clockIn(await user(empA), { deviceKnown: true }), /Already checked in/);

  s = await breakAction(await user(empA), "start");
  assert.equal(s.status, "break");
  await assert.rejects(breakAction(await user(empA), "start"), /already running/);
  s = await breakAction(await user(empA), "end");
  assert.equal(s.status, "working");
  await assert.rejects(breakAction(await user(empA), "end"), /No break running/);

  s = await clockOut(await user(empA));
  assert.equal(s.status, "complete");
  await assert.rejects(clockOut(await user(empA)), /Not checked in/);
  const att = s.attendance;
  assert.equal(att.status, "completed");
  assert.ok(att.worked_minutes >= 0);
  assert.ok(att.break_minutes >= 0);
  await assert.rejects(breakAction(await user(empA), "start"), /Not currently working/);

  // Sessions model: coming back the same day opens a NEW session.
  s = await clockIn(await user(empA), { deviceKnown: true });
  assert.equal(s.status, "working");
  assert.equal(s.sessions.length, 2);
  s = await clockOut(await user(empA));
  assert.equal(s.sessions.length, 2);
  assert.ok(s.sessions.every((x) => x.clock_out), "both sessions closed");
  // Day total = sum of both sessions.
  const total = s.sessions.reduce((a, x) => a + x.worked_minutes, 0);
  assert.equal(s.worked_min, total);
});

test("check-out without an open session is rejected", async () => {
  await assert.rejects(clockOut(await user(empA2)), /Not checked in/);
});

test("no-shift + unknown-device clock-in is held for review and flagged", async () => {
  const s = await clockIn(await user(empA2), { deviceKnown: false });
  assert.equal(s.status, "requires_review");
  assert.equal(s.attendance.risk_level, "high");
  const flags = await db.all("SELECT * FROM attendance_flags WHERE user_id = ?", empA2);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].risk_level, "high");
});

test("require_shift_to_clock_in blocks unscheduled clock-ins when enabled", async () => {
  await setSetting(orgA, "require_shift_to_clock_in", true);
  await assert.rejects(clockIn(await user(mgrA), { deviceKnown: true }), /no scheduled shift/);
  await setSetting(orgA, "require_shift_to_clock_in", false);
});

test("tap toggle: in → double-tap guard → out → in again (new session)", async () => {
  const empTap = await insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, job_role_id, location_id, pin)
    VALUES (?, 'Tap', 'User', 'tap@a.test', 'x:x', 'employee', ?, ?, '9876')
  `, orgA, roleA, locA);

  let r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "in");
  assert.equal(r.today.attendance.clock_in_method, "NFC");

  // Immediate second tap is an accidental double tap, not a clock-out.
  r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "in_recent");
  assert.equal(r.today.status, "working");

  // Backdate the clock-in past the guard window → next tap clocks out.
  await db.run(
    "UPDATE attendance SET clock_in = ? WHERE user_id = ? AND clock_out IS NULL",
    new Date(Date.now() - 5 * 60000).toISOString(), empTap
  );
  r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "out");
  assert.ok(r.today.attendance.clock_out);

  // Scanning again after checking out starts a NEW session — no daily limit.
  r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "in");
  assert.equal(r.today.sessions.length, 2);
});

// ---------------------------------------------------------------- scheduling
test("overlapping shifts and invalid times are rejected", async () => {
  const date = "2030-01-07";
  await createShift(await user(mgrA), { user_id: empA, date, start_time: "08:00", end_time: "16:00", location_id: locA });
  await assert.rejects(
    createShift(await user(mgrA), { user_id: empA, date, start_time: "15:00", end_time: "20:00", location_id: locA }),
    /Overlaps/
  );
  await assert.rejects(
    validateShift({ userId: empA, date, startTime: "18:00", endTime: "17:00" }),
    /end after it starts/
  );
  // Non-overlapping second shift is fine.
  await createShift(await user(mgrA), { user_id: empA, date, start_time: "17:00", end_time: "20:00", location_id: locA });
});

test("shifts cannot be scheduled at a location the employee is not assigned to", async () => {
  const locB = await insert("INSERT INTO locations (organization_id, name) VALUES (?, 'Clinic A2')", orgA);
  await assert.rejects(
    createShift(await user(mgrA), { user_id: empA, date: "2030-01-08", start_time: "08:00", end_time: "16:00", location_id: locB }),
    /not assigned/
  );
  await db.run("INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?)", empA, locB);
  await createShift(await user(mgrA), { user_id: empA, date: "2030-01-08", start_time: "08:00", end_time: "16:00", location_id: locB });
});

test("scheduling over approved leave is rejected", async () => {
  const { id } = await requestLeave(await user(empA), { type: "unpaid", start_date: "2030-02-03", end_date: "2030-02-04", note: "" });
  await decide(await user(mgrA), "leave", id, "approved");
  await assert.rejects(
    createShift(await user(mgrA), { user_id: empA, date: "2030-02-03", start_time: "08:00", end_time: "16:00", location_id: locA }),
    /approved leave/
  );
});

// ---------------------------------------------------------------- security
test("cross-organization access is blocked", async () => {
  // Manager from org A cannot schedule org B's employee…
  await assert.rejects(
    createShift(await user(mgrA), { user_id: empB, date: "2030-01-09", start_time: "08:00", end_time: "16:00" }),
    /not found/
  );
  // …and org A approvals never contain org B data.
  await requestLeave(await user(empB), { type: "unpaid", start_date: "2030-03-03", end_date: "2030-03-03", note: "" });
  const pending = await pendingApprovals(orgA);
  assert.ok(pending.leaves.every((l) => l.user_id !== empB));
  // …and cannot decide org B's requests.
  const reqB = await db.get("SELECT id FROM leave_requests WHERE user_id = ?", empB);
  await assert.rejects(decide(await user(mgrA), "leave", reqB.id, "approved"), /not found/i);
});

// ---------------------------------------------------------------- challenges
test("checkpoint challenges are single-use and org-scoped", async () => {
  await db.run(`
    INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
    VALUES (?, ?, 'Door', 'QR', 'test-door')
  `, orgA, locA);
  const cp = await checkpointByCode("test-door");
  const ch = await createChallenge(cp);

  // Wrong org cannot consume (and must not burn the challenge).
  assert.equal(await consumeChallenge(ch.token, await user(empB)), null);
  // First valid consumption wins…
  const got = await consumeChallenge(ch.token, await user(empA));
  assert.equal(got.code, "test-door");
  // …replays fail.
  assert.equal(await consumeChallenge(ch.token, await user(empA)), null);
  // Unknown/garbage tokens fail.
  assert.equal(await consumeChallenge("nonsense", await user(empA)), null);
});

test("expired challenges are rejected", async () => {
  const cp = await checkpointByCode("test-door");
  const ch = await createChallenge(cp);
  await db.run("UPDATE attendance_challenges SET expires_at = ? WHERE token = ?",
    new Date(Date.now() - 1000).toISOString(), ch.token);
  assert.equal(await consumeChallenge(ch.token, await user(empA)), null);
});

// ---------------------------------------------------------------- corrections audit
test("approved corrections update attendance and leave an audit trail", async () => {
  const corrId = await requestCorrection(await user(empA), {
    date: "2030-01-07", kind: "missing_in", requested_in: "08:05", requested_out: "", reason: "forgot",
  });
  await decide(await user(mgrA), "correction", corrId, "approved");
  const att = await db.get("SELECT * FROM attendance WHERE user_id = ? AND date = '2030-01-07'", empA);
  assert.equal(att.clock_in_method, "MANUAL_APPROVED");
  assert.equal(att.status, "corrected");
  const auditRow = await db.get(
    "SELECT * FROM audit_log WHERE action = 'attendance_corrected' AND entity_id = ?", att.id
  );
  assert.ok(auditRow, "audit entry exists");
});
