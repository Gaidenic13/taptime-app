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
const { clockIn, clockOut, breakAction, tapToggle, hasOpenSession } = await import("../domains/attendance.js");
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
  // The no-shift signal only applies to orgs that actually schedule shifts.
  await db.run(`
    INSERT INTO shifts (organization_id, user_id, date, start_time, end_time)
    VALUES (?, ?, '2020-01-06', '08:00', '16:00')
  `, orgA, mgrA);
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

test("tap toggle: scan checks in, explicit tap checks out, scan again opens a new session", async () => {
  const empTap = await insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, job_role_id, location_id, pin)
    VALUES (?, 'Tap', 'User', 'tap@a.test', 'x:x', 'employee', ?, ?, '9876')
  `, orgA, roleA, locA);

  let r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "in");
  assert.equal(r.today.attendance.clock_in_method, "NFC");
  assert.equal(await hasOpenSession(empTap), true);

  // The Clock out button is always deliberate — no guard window.
  r = await tapToggle(await user(empTap), { method: "NFC", locationId: locA });
  assert.equal(r.did, "out");
  assert.ok(r.today.attendance.clock_out);
  assert.equal(await hasOpenSession(empTap), false);

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

// ---------------------------------------------------------------- self-serve signup
test("signup provisions org + admin + checkpoint; quick-add members scan without shifts un-flagged", async () => {
  const { createOrganization, quickAddMember } = await import("../domains/org.js");
  const s = await createOrganization({
    clinic_name: "Test Clinic", first_name: "Ada", last_name: "Admin",
    email: "ada@new.test", password: "secret1",
  });
  assert.ok(s.token && s.user.id && s.checkpoint_code);
  assert.equal(s.user.role, "admin");

  // Duplicate email rejected.
  await assert.rejects(createOrganization({
    clinic_name: "X", first_name: "A", last_name: "B", email: "ada@new.test", password: "secret1",
  }), /already has an account/);

  // Quick-add: name only → unique PIN, no email.
  const m = await quickAddMember(s.user, { first_name: "Mia", last_name: "Member" });
  assert.ok(m.id, "quick-add returns the member id (no code — phones get linked by the admin)");
  const member = await user(m.id);
  assert.equal(member.email, null);

  // A brand-new clinic without shift scheduling: first scan is NOT flagged.
  const r = await tapToggle(member, { method: "NFC", deviceKnown: false });
  assert.equal(r.did, "in");
  assert.equal(r.today.attendance.risk_level, "low");
  assert.equal(r.today.status, "working");
});

test("pre-written tag: claim binds org, duplicate claims rejected, scans record the device", async () => {
  const { claimTag, makeClaimCode, quickAddMember } = await import("../domains/org.js");
  const { touchDevice } = await import("../auth.js");
  await db.run(
    "INSERT INTO provisioned_tags (claim_code, code, created_at) VALUES (?, 'tag-abc-123', ?)",
    makeClaimCode(), new Date().toISOString()
  );

  // Unknown tag rejected.
  await assert.rejects(claimTag({
    tag_code: "no-such-tag",
    clinic_name: "Boxed Clinic", first_name: "B", last_name: "Ox", email: "box@t.test", password: "secret1",
  }), /not recognized/);

  // First claim wins: provisions the org and binds the tag's code as checkpoint.
  const s = await claimTag({
    tag_code: "tag-abc-123",
    clinic_name: "Boxed Clinic", first_name: "B", last_name: "Ox", email: "box@t.test", password: "secret1",
  });
  const cp = await db.get("SELECT * FROM attendance_checkpoints WHERE code = 'tag-abc-123'");
  assert.equal(cp.organization_id, s.user.organization_id);

  // Second claim of the same tag rejected.
  await assert.rejects(claimTag({
    tag_code: "tag-abc-123",
    clinic_name: "X", first_name: "A", last_name: "B", email: "x2@t.test", password: "secret1",
  }), /already linked/);

  // A member's scan records WHICH device checked in.
  const m = await quickAddMember(s.user, { first_name: "Devi", last_name: "Ce" });
  const member = await user(m.id);
  const { deviceId } = await touchDevice(member.id, "device-token-of-devi-phone-1", "test-agent");
  assert.ok(deviceId, "device registered");
  const r = await tapToggle(member, { method: "NFC", deviceId });
  assert.equal(r.today.attendance.device_id, deviceId);
});

test("second tag attaches to the SAME clinic as another entrance", async () => {
  const { attachTag, attachTagAsAdmin, makeClaimCode } = await import("../domains/org.js");
  await db.run(
    "INSERT INTO provisioned_tags (claim_code, code, created_at) VALUES (?, 'tag-second-door', ?)",
    makeClaimCode(), new Date().toISOString()
  );
  const admin = await db.get("SELECT * FROM users WHERE email = 'box@t.test'");

  // Wrong password rejected.
  await assert.rejects(attachTag({
    tag_code: "tag-second-door", email: "box@t.test", password: "wrong",
  }), /Invalid email or password/);

  // Session-based attach: nothing but the tag itself.
  const res = await attachTagAsAdmin(admin, { tag_code: "tag-second-door" });
  assert.equal(res.clinic, "Boxed Clinic");
  assert.match(res.checkpoint.name, /Entrance 2/);

  // Both tags now belong to ONE org — scans through either feed the same records.
  const cps = await db.all(
    "SELECT code FROM attendance_checkpoints WHERE organization_id = ? ORDER BY id", admin.organization_id
  );
  assert.deepEqual(cps.map((c) => c.code), ["tag-abc-123", "tag-second-door"]);

  // And the second tag cannot be claimed as a new clinic anymore.
  const { claimTag } = await import("../domains/org.js");
  await assert.rejects(claimTag({
    tag_code: "tag-second-door",
    clinic_name: "X", first_name: "A", last_name: "B", email: "x9@t.test", password: "secret1",
  }), /already linked/);
});

test("trusted phone: every link is admin-approved and only that phone scans", async () => {
  const {
    joinClinic, requestPhoneLink, linkStatus, decidePhoneLink, unlinkPhone, isTrustedPhone, pendingLinks, phoneReplaced,
    resumeOnTrustedPhone,
  } = await import("../domains/phones.js");
  const admin = await db.get("SELECT * FROM users WHERE email = 'box@t.test'");
  const PHONE_A = "phone-a-0123456789abcdef", PHONE_B = "phone-b-0123456789abcdef";
  const tag = "tag-abc-123";

  // Newcomer from phone A: pending account + link request, no code, no session.
  const { user: nou, link, created } = await joinClinic({
    tag_code: tag, first_name: "Nou", last_name: "Venit", device_token: PHONE_A, user_agent: "test",
  });
  assert.equal(created, true);
  assert.equal(nou.employment_status, "pending");
  assert.equal(nou.pin, "");
  assert.equal((await linkStatus(link.token, PHONE_A)).status, "pending");
  const again = await joinClinic({ tag_code: tag, first_name: "nou", last_name: "VENIT", device_token: PHONE_A });
  assert.equal(again.created, false);
  assert.equal(again.link.id, link.id);
  await assert.rejects(tapToggle(await user(nou.id), { method: "NFC" }), /waiting for the clinic admin/);

  // Approve → account active, phone A trusted, the session goes to phone A exactly once.
  await decidePhoneLink(admin, link.id, "approved");
  assert.equal((await linkStatus(link.token, PHONE_B)).session, undefined, "another phone can't take the session");
  assert.ok((await linkStatus(link.token, PHONE_A)).session);
  assert.equal((await linkStatus(link.token, PHONE_A)).session, undefined, "exchanged once");
  let u = await user(nou.id);
  assert.equal(u.employment_status, "active");
  assert.equal(await isTrustedPhone(u, PHONE_A), true);
  assert.equal(await isTrustedPhone(u, PHONE_B), false);
  assert.equal((await tapToggle(u, { method: "NFC", want: "in" })).did, "in");
  // The button pressed must match the state: no accidental flips.
  await assert.rejects(tapToggle(u, { method: "NFC", want: "in" }), /already clocked in/);
  assert.equal((await tapToggle(u, { method: "NFC", want: "out" })).did, "out");
  await assert.rejects(tapToggle(u, { method: "NFC", want: "out" }), /not clocked in/);

  // A colleague's phone asks to become Nou's phone: pending + flagged as a
  // replacement; phone A keeps working until the admin decides.
  const { link: swap, replaces } = await requestPhoneLink({
    tag_code: tag, first_name: "nou", last_name: "", device_token: PHONE_B, user_agent: "x",
  });
  assert.equal(replaces, true);
  assert.ok((await pendingLinks(admin.organization_id)).some((l) => l.id === swap.id && l.replaces === 1));
  assert.equal(await isTrustedPhone(await user(nou.id), PHONE_A), true);
  await assert.rejects(requestPhoneLink({ tag_code: tag, first_name: "Nimeni", device_token: PHONE_B }), /couldn't find/);
  await assert.rejects(requestPhoneLink({ tag_code: tag, first_name: "Nou", last_name: "Venit", device_token: PHONE_A }), /already linked/);

  // Rejected → nothing changes. Approved replacement → phone A dies, B is the one.
  await decidePhoneLink(admin, swap.id, "rejected");
  assert.equal(await isTrustedPhone(await user(nou.id), PHONE_A), true);
  const { link: swap2 } = await requestPhoneLink({ tag_code: tag, first_name: "Nou", last_name: "Venit", device_token: PHONE_B });
  await decidePhoneLink(admin, swap2.id, "approved");
  u = await user(nou.id);
  assert.equal(await isTrustedPhone(u, PHONE_B), true);
  assert.equal(await isTrustedPhone(u, PHONE_A), false);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", nou.id)).n, 0, "old sessions revoked");
  assert.equal((await phoneReplaced(PHONE_A)).replaced, true);
  // Signing out never un-trusts a phone: B resumes on its own, A cannot.
  assert.ok((await resumeOnTrustedPhone(PHONE_B)).session);
  await assert.rejects(resumeOnTrustedPhone(PHONE_A), /isn't linked/);

  // Another clinic's admin can't decide; unlink drops the trusted phone.
  const outsider = await db.get("SELECT * FROM users WHERE email = 'e@b.test'");
  await assert.rejects(decidePhoneLink({ ...outsider, role: "admin" }, swap2.id, "approved"), /not found/);
  await unlinkPhone(admin, nou.id);
  assert.equal((await user(nou.id)).trusted_device_id, null);
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
