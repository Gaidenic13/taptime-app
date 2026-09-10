import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { db, insert } from "./db.js";
import { audit } from "./audit.js";
import { getSettings, setSetting, DEFAULT_SETTINGS } from "./settings.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, requireManager, requireAdmin, touchDevice, registerKiosk, requireKiosk,
  assertPinAllowed, recordPinAttempt, setSessionCookie, clearSessionCookie,
} from "./auth.js";
import { dayStatus, clockIn, clockOut, breakAction, resolveReview, tapToggle, hasOpenSession } from "./domains/attendance.js";
import { createShift, deleteShift, weekShifts } from "./domains/scheduling.js";
import { coverageFor } from "./domains/staffing.js";
import {
  requestLeave, requestCorrection, pendingApprovals, decide, resolveFlag,
} from "./domains/requests.js";
import {
  checkpointByCode, createChallenge, consumeChallenge, createCheckpoint, createKiosk, resetKiosk,
} from "./domains/checkpoints.js";
import { listNotifications, unreadCount, markAllRead } from "./domains/notifications.js";
import { createOrganization, claimTag, attachTag, attachTagAsAdmin, quickAddMember, makeClaimCode } from "./domains/org.js";
import crypto from "crypto";
import { attendanceReport, leaveReport, staffingReport } from "./domains/reports.js";
import { todayStr, mondayOf, addDays, workedMinutes, breakMinutes } from "./time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

async function publicUser(u) {
  if (!u) return null;
  const { password_hash, pin, ...rest } = u;
  const jr = rest.job_role_id
    ? await db.get("SELECT name FROM job_roles WHERE id = ?", rest.job_role_id) : null;
  rest.job_title = jr?.name || "—";
  return rest;
}

const handle = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

// ---------------------------------------------------------------- factory (vendor)
// The vendor's production floor: mint tags, see inventory & claim status.
// Guarded by FACTORY_KEY (X-Factory-Key header); a fixed dev key applies
// locally so the page works out of the box during development.
const factoryKey = () =>
  process.env.FACTORY_KEY || (!process.env.VERCEL ? "dev-factory" : null);

const requireFactory = (req, res, next) => {
  const key = factoryKey();
  if (!key) return res.status(503).json({ error: "Factory is not configured on this deployment" });
  if ((req.headers["x-factory-key"] || "") !== key) {
    return res.status(401).json({ error: "Invalid factory key" });
  }
  next();
};

app.post("/api/factory/tags", requireFactory, handle(async (req) => {
  const count = Math.min(50, Math.max(1, Number(req.body?.count) || 1));
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(8).toString("hex");
    await db.run(
      "INSERT INTO provisioned_tags (claim_code, code, created_at) VALUES (?, ?, ?)",
      makeClaimCode(), code, new Date().toISOString()
    );
    codes.push(code);
  }
  return { codes };
}));

app.get("/api/factory/tags", requireFactory, handle(async () => ({
  tags: await db.all(`
    SELECT pt.id, pt.code, pt.created_at, pt.claimed_at,
           o.name AS clinic, cp.name AS entrance
    FROM provisioned_tags pt
    LEFT JOIN organizations o ON o.id = pt.organization_id
    LEFT JOIN attendance_checkpoints cp ON cp.code = pt.code
    ORDER BY pt.id DESC LIMIT 100
  `),
})));

// Only UNCLAIMED tags can be deleted — a claimed tag is a live entrance of a
// real clinic and must never disappear from under it.
app.delete("/api/factory/tags/:id", requireFactory, handle(async (req) => {
  const tag = await db.get("SELECT * FROM provisioned_tags WHERE id = ?", req.params.id);
  if (!tag) throw new Error("Tag not found");
  if (tag.organization_id) throw new Error("This tag is claimed by a clinic — it cannot be deleted");
  await db.run("DELETE FROM provisioned_tags WHERE id = ?", tag.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- signup (self-serve)
app.post("/api/orgs/signup", handle(async (req) => createOrganization(req.body || {})));

// Pre-written tag claim: the scan page posts the tag's code + the setup code
// from the box, plus the clinic/admin details. Binds the tag to the new org.
app.post("/api/orgs/claim", handle(async (req) => claimTag(req.body || {})));

// Additional tag for an EXISTING clinic (a second/third TapTime for more
// doors): setup code + admin sign-in, or just the setup code when the
// scanning phone already holds an admin session.
app.post("/api/orgs/attach", handle(async (req) => attachTag(req.body || {})));
app.post("/api/orgs/attach-session", requireAuth, handle(async (req) =>
  attachTagAsAdmin(req.user, req.body || {})
));

// ---------------------------------------------------------------- auth
app.post("/api/auth/login", handle(async (req, res) => {
  const { email, password } = req.body || {};
  const user = email
    ? await db.get("SELECT * FROM users WHERE email = ? AND active = 1", email.trim().toLowerCase())
    : null;
  if (!user || !user.password_hash || !verifyPassword(password || "", user.password_hash)) {
    const err = new Error("Invalid email or password"); err.status = 401; throw err;
  }
  // The app login is for managers/admins only — team members just scan.
  if (user.role === "employee") {
    const err = new Error("Team members don't sign in — just scan the clinic tag");
    err.status = 403; throw err;
  }
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  await touchDevice(user.id, req.headers["x-device-token"], req.headers["user-agent"]);
  await audit({ orgId: user.organization_id, actorId: user.id, action: "login" });
  return { token, user: await publicUser(user) };
}));

app.post("/api/auth/logout", requireAuth, handle(async (req, res) => {
  await destroySession(req.token);
  clearSessionCookie(res);
  return { ok: true };
}));

app.get("/api/me", requireAuth, handle(async (req) => {
  await touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  const user = await publicUser(req.user);
  // Members see their own personal code — it's their key on any phone.
  if (req.user.role === "employee") user.code = req.user.pin || null;
  return {
    user,
    token: req.token, // lets a cookie-recognized phone restore its storage token
    today: await dayStatus(req.user.id, todayStr()),
    unread_notifications: await unreadCount(req.user.id),
  };
}));

// ---------------------------------------------------------------- clock actions (web)
app.post("/api/attendance/clock-in", requireAuth, handle(async (req) => {
  const { known, deviceId } = await touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  return {
    today: await clockIn(req.user, {
      method: "WEB", locationId: req.body?.location_id || null,
      geo: req.body?.geo || null, deviceKnown: known, deviceId,
    }),
  };
}));
app.post("/api/attendance/clock-out", requireAuth, handle(async (req) => ({
  today: await clockOut(req.user, { method: "WEB", locationId: req.body?.location_id || null }),
})));
app.post("/api/attendance/break-start", requireAuth, handle(async (req) => ({ today: await breakAction(req.user, "start") })));
app.post("/api/attendance/break-end", requireAuth, handle(async (req) => ({ today: await breakAction(req.user, "end") })));

// ---------------------------------------------------------------- checkpoint flow (QR/NFC)
// Public: reaching a checkpoint creates a short-lived challenge. Identity comes
// from the session that consumes it — the code alone never clocks anyone in.
app.get("/api/checkpoint/:code", handle(async (req) => {
  const cp = await checkpointByCode(req.params.code);
  if (!cp) {
    // A factory-written tag that nobody claimed yet: scanning it starts the
    // create-your-clinic flow instead of erroring.
    const tag = await db.get(
      "SELECT * FROM provisioned_tags WHERE code = ? AND organization_id IS NULL",
      String(req.params.code || "").trim()
    );
    if (tag) return { unclaimed: true };
    const e = new Error("Checkpoint not found"); e.status = 404; throw e;
  }
  const ch = await createChallenge(cp);
  return {
    challenge: ch.token, expires_in: ch.expires_in,
    checkpoint: { name: cp.name, type: cp.type, location: cp.location_name },
  };
}));

app.post("/api/checkpoint/consume", requireAuth, handle(async (req) => {
  const { challenge, action, geo } = req.body || {};
  const cp = await consumeChallenge(challenge, req.user);
  if (!cp) { const e = new Error("This code has expired — tap or scan again"); e.status = 410; throw e; }
  const { known, deviceId } = await touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  if (action === "clock-out") {
    return { today: await clockOut(req.user, { method: cp.type, locationId: cp.location_id }) };
  }
  return {
    today: await clockIn(req.user, {
      method: cp.type, locationId: cp.location_id, geo: geo || null,
      viaCheckpoint: true, deviceKnown: known, deviceId, checkpointId: cp.id,
    }),
  };
}));

// PIN tap flow (public): the friendliest path for employees — tap the tag,
// enter your 4-digit PIN, and the server decides in vs out. The challenge
// scopes the PIN lookup to the checkpoint's organization; wrong PINs are
// rate-limited per device/IP and never burn the challenge.
app.post("/api/checkpoint/pin", handle(async (req, res) => {
  const { challenge, pin, geo } = req.body || {};
  const source = req.headers["x-device-token"] || req.ip || "unknown";
  await assertPinAllowed(source);

  const now = new Date().toISOString();
  const ch = await db.get(
    "SELECT * FROM attendance_challenges WHERE token = ? AND consumed_at IS NULL AND expires_at > ?",
    challenge, now
  );
  if (!ch) { const e = new Error("This code has expired — tap the tag again"); e.status = 410; throw e; }

  const user = await db.get(
    "SELECT * FROM users WHERE pin = ? AND pin != '' AND active = 1 AND organization_id = ?",
    String(pin || ""), ch.organization_id
  );
  if (!user) {
    await recordPinAttempt(source, false);
    const e = new Error("PIN not recognized"); e.status = 401; throw e;
  }
  await recordPinAttempt(source, true);

  const cp = await consumeChallenge(challenge, user);
  if (!cp) { const e = new Error("This code has expired — tap the tag again"); e.status = 410; throw e; }
  const { known, deviceId } = await touchDevice(user.id, req.headers["x-device-token"], req.headers["user-agent"]);
  // Entering the code on a phone while already checked in only LINKS the
  // phone — it never clocks anyone out; that takes the explicit button.
  const result = (await hasOpenSession(user.id))
    ? { did: "linked", today: await dayStatus(user.id, todayStr()) }
    : await tapToggle(user, {
        method: cp.type, locationId: cp.location_id, geo: geo || null, deviceKnown: known, deviceId,
        checkpointId: cp.id,
      });
  // Activation: the code is entered once — the phone gets a persistent member
  // session (storage token + year-long cookie), so every later scan records
  // in/out with no typing at all.
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  return { user: { first_name: user.first_name }, token, ...result };
}));

// Auto-scan for activated phones: an employee session + a fresh challenge is
// all it takes — the server decides in vs out and records the device.
app.post("/api/checkpoint/tap", requireAuth, handle(async (req) => {
  const { challenge, geo } = req.body || {};
  const cp = await consumeChallenge(challenge, req.user);
  if (!cp) { const e = new Error("This code has expired — tap the tag again"); e.status = 410; throw e; }
  const { known, deviceId } = await touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  const result = await tapToggle(req.user, {
    method: cp.type, locationId: cp.location_id, geo: geo || null, deviceKnown: known, deviceId,
    checkpointId: cp.id,
  });
  return { user: { first_name: req.user.first_name }, ...result };
}));

// ---------------------------------------------------------------- kiosk (restricted session)
app.post("/api/kiosk/register", handle(async (req) => registerKiosk(req.body?.setup_code)));

const kioskUser = (req) => db.get(
  "SELECT * FROM users WHERE pin = ? AND pin != '' AND active = 1 AND organization_id = ?",
  String(req.body?.pin || ""), req.orgId
);

app.post("/api/kiosk/pin", requireKiosk, handle(async (req) => {
  const user = await kioskUser(req);
  if (!user) { const e = new Error("PIN not recognized"); e.status = 401; throw e; }
  return { user: await publicUser(user), today: await dayStatus(user.id, todayStr()) };
}));

app.post("/api/kiosk/:action", requireKiosk, handle(async (req) => {
  const user = await kioskUser(req);
  if (!user) { const e = new Error("PIN not recognized"); e.status = 401; throw e; }
  const map = {
    "clock-in": () => clockIn(user, { method: "KIOSK", locationId: req.kiosk.location_id, deviceKnown: true }),
    "clock-out": () => clockOut(user, { method: "KIOSK", locationId: req.kiosk.location_id }),
    "break-start": () => breakAction(user, "start"),
    "break-end": () => breakAction(user, "end"),
  };
  const fn = map[req.params.action];
  if (!fn) { const e = new Error("Unknown action"); e.status = 404; throw e; }
  return { user: await publicUser(user), today: await fn() };
}));

// ---------------------------------------------------------------- my attendance
app.get("/api/attendance/history", requireAuth, handle(async (req) => {
  const month = req.query.month || todayStr().slice(0, 7);
  const userId = Number(req.query.user_id) || req.user.id;
  if (userId !== req.user.id && req.user.role === "employee") {
    const e = new Error("Forbidden"); e.status = 403; throw e;
  }
  if (userId !== req.user.id) {
    const target = await db.get("SELECT organization_id FROM users WHERE id = ?", userId);
    if (!target || target.organization_id !== req.orgId) { const e = new Error("Forbidden"); e.status = 403; throw e; }
  }
  const shifts = await db.all("SELECT * FROM shifts WHERE user_id = ? AND date LIKE ? ORDER BY date", userId, `${month}%`);
  const atts = await db.all("SELECT * FROM attendance WHERE user_id = ? AND date LIKE ? ORDER BY date", userId, `${month}%`);
  const leaves = await db.all(
    "SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?",
    userId, `${month}-31`, `${month}-01`
  );
  const corrections = await db.all("SELECT * FROM corrections WHERE user_id = ? AND date LIKE ?", userId, `${month}%`);

  const byDate = {};
  for (const s of shifts) byDate[s.date] = { date: s.date, shift: s };
  for (const a of atts) {
    byDate[a.date] = byDate[a.date] || { date: a.date };
    const d = byDate[a.date];
    const breaks = await db.all("SELECT * FROM breaks WHERE attendance_id = ?", a.id);
    d.sessions = d.sessions || [];
    d.sessions.push(a);
    d.attendance = a; // latest session (kept for status pills)
    d.worked_min = (d.worked_min || 0) + (a.clock_out ? (a.worked_minutes ?? workedMinutes(a, breaks)) : workedMinutes(a, breaks));
    d.break_min = (d.break_min || 0) + (a.break_minutes ?? breakMinutes(breaks));
  }
  for (const c of corrections) if (byDate[c.date]) byDate[c.date].correction = c;
  for (const l of leaves) {
    for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) {
      if (d.slice(0, 7) !== month) continue;
      byDate[d] = byDate[d] || { date: d };
      byDate[d].leave = { type: l.type };
    }
  }
  return { month, days: Object.values(byDate).sort((a, b) => (a.date < b.date ? 1 : -1)) };
}));

// ---------------------------------------------------------------- schedule
app.get("/api/schedule", requireAuth, handle(async (req) => {
  const week = req.query.week || mondayOf(todayStr());
  const scopeAll = req.query.all === "1" && req.user.role !== "employee";
  const filters = scopeAll
    ? {
        locationId: Number(req.query.location_id) || null,
        jobRoleId: Number(req.query.job_role_id) || null,
        userId: Number(req.query.user_id) || null,
      }
    : { userId: req.user.id };
  return { week, shifts: await weekShifts(req.orgId, week, addDays(week, 6), filters) };
}));

app.post("/api/schedule", requireAuth, requireManager, handle(async (req) => {
  const b = req.body || {};
  if (!b.user_id || !b.date || !b.start_time || !b.end_time) {
    throw new Error("user_id, date, start_time, end_time required");
  }
  return { id: await createShift(req.user, b) };
}));

app.delete("/api/schedule/:id", requireAuth, requireManager, handle(async (req) => {
  await deleteShift(req.user, Number(req.params.id));
  return { ok: true };
}));

// ---------------------------------------------------------------- corrections & leave
app.post("/api/corrections", requireAuth, handle(async (req) => ({ id: await requestCorrection(req.user, req.body || {}) })));
app.get("/api/corrections", requireAuth, handle(async (req) => ({
  corrections: await db.all(
    "SELECT * FROM corrections WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", req.user.id
  ),
})));

app.get("/api/leave", requireAuth, handle(async (req) => ({
  balance: req.user.leave_balance,
  requests: await db.all(
    "SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", req.user.id
  ),
})));
app.post("/api/leave", requireAuth, handle(async (req) => requestLeave(req.user, req.body || {})));

// ---------------------------------------------------------------- team & approvals (manager)
app.get("/api/team/today", requireAuth, requireManager, handle(async (req) => {
  const date = req.query.date || todayStr();
  const locationId = Number(req.query.location_id) || null;
  const users = await db.all(`
    SELECT u.*, jr.name AS job_title, l.name AS location_name FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = u.location_id
    WHERE u.organization_id = ? AND u.active = 1 ${locationId ? "AND u.location_id = ?" : ""}
    ORDER BY jr.name, u.last_name
  `, ...(locationId ? [req.orgId, locationId] : [req.orgId]));
  // Entrance names shown per session, but only when the clinic has several.
  const cps = await db.all(
    "SELECT id, name FROM attendance_checkpoints WHERE organization_id = ?", req.orgId
  );
  const cpName = cps.length > 1 ? new Map(cps.map((c) => [c.id, c.name])) : null;

  const roster = [];
  for (const u of users) {
    const d = await dayStatus(u.id, date);
    roster.push({
      id: u.id, name: `${u.first_name} ${u.last_name}`, job_title: u.job_title || "—",
      location: u.location_name, status: d.status,
      shift: d.shift ? `${d.shift.start_time}–${d.shift.end_time}` : null,
      clock_in: d.first_in,
      clock_out: d.last_out,
      method: d.attendance?.clock_in_method || null,
      risk: d.attendance?.risk_level || null,
      worked_min: d.worked_min,
      sessions: d.sessions.map((s) => ({
        in: s.clock_in, out: s.clock_out, method: s.clock_in_method,
        device_id: s.device_id || null,
        entrance: (cpName && s.checkpoint_id && cpName.get(s.checkpoint_id)) || null,
        minutes: s.clock_out ? s.worked_minutes : null,
      })),
    });
  }
  const counts = {};
  for (const r of roster) counts[r.status] = (counts[r.status] || 0) + 1;

  const coverage = {};
  for (const r of roster) {
    if (!r.shift) continue;
    coverage[r.job_title] = coverage[r.job_title] || { scheduled: 0, present: 0 };
    coverage[r.job_title].scheduled++;
    if (["working", "break", "complete"].includes(r.status)) coverage[r.job_title].present++;
  }

  const staffing = await coverageFor(req.orgId, date, { locationId });
  const pending = await pendingApprovals(req.orgId);
  return {
    date, counts, roster, coverage, staffing,
    pending_actions: {
      leaves: pending.leaves.length,
      corrections: pending.corrections.length,
      overtime: pending.overtime.length,
      reviews: pending.reviews.length,
      flags: pending.flags.length,
      staffing_gaps: staffing.alerts.length,
    },
  };
}));

app.get("/api/approvals", requireAuth, requireManager, handle(async (req) => pendingApprovals(req.orgId)));
app.post("/api/approvals/:type/:id", requireAuth, requireManager, handle(async (req) => {
  await decide(req.user, req.params.type, req.params.id, req.body?.decision, req.body?.note || "");
  return { ok: true };
}));
app.post("/api/reviews/:attendanceId", requireAuth, requireManager, handle(async (req) => {
  await resolveReview(req.user, Number(req.params.attendanceId), req.body?.decision, req.body?.note || "");
  return { ok: true };
}));
app.post("/api/flags/:id/resolve", requireAuth, requireManager, handle(async (req) => {
  await resolveFlag(req.user, Number(req.params.id), req.body?.note || "");
  return { ok: true };
}));

// ---------------------------------------------------------------- notifications
app.get("/api/notifications", requireAuth, handle(async (req) => ({
  unread: await unreadCount(req.user.id),
  notifications: await listNotifications(req.user.id),
})));
app.post("/api/notifications/read-all", requireAuth, handle(async (req) => {
  await markAllRead(req.user.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- org directory
app.get("/api/employees", requireAuth, requireManager, handle(async (req) => ({
  employees: (await db.all(`
    SELECT u.*, jr.name AS job_title, l.name AS location_name, d.name AS department_name FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = u.location_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.organization_id = ? ORDER BY u.active DESC, u.last_name
  `, req.orgId)).map((u) => { const { password_hash, ...rest } = u; return rest; }),
})));

// PINs identify employees at checkpoints/kiosks, so they must be unique per org.
async function assertPinFree(orgId, pin, excludeUserId = null) {
  if (!pin) return;
  const clash = await db.get(
    "SELECT id FROM users WHERE organization_id = ? AND pin = ? AND id != ?",
    orgId, String(pin), excludeUserId || 0
  );
  if (clash) throw new Error("That PIN is already used by another employee — pick a different one");
}

// One-field onboarding: name in, unique PIN out — no email, no password.
app.post("/api/employees/quick", requireAuth, requireAdmin, handle(async (req) =>
  quickAddMember(req.user, req.body || {})
));

app.post("/api/employees", requireAuth, requireAdmin, handle(async (req) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name) throw new Error("first_name and last_name required");
  // Email is only needed when the person will LOG IN (manager/admin, or an
  // employee who wants app access). Scan-only members need just a PIN.
  if ((b.role && b.role !== "employee") && !b.email) {
    throw new Error("Managers and admins need an email to sign in");
  }
  await assertPinFree(req.orgId, b.pin);
  try {
    const id = await insert(`
      INSERT INTO users (organization_id, first_name, last_name, email, phone, password_hash, pin, role,
                         job_role_id, department_id, location_id, manager_id, employment_start, leave_balance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      req.orgId, b.first_name, b.last_name, b.email ? b.email.trim().toLowerCase() : null, b.phone || "",
      b.email ? hashPassword(b.password || "taptime123") : "", b.pin || "", b.role || "employee",
      b.job_role_id || null, b.department_id || null, b.location_id || null,
      b.manager_id || req.user.id, b.employment_start || todayStr(), b.leave_balance ?? 21
    );
    await audit({
      orgId: req.orgId, actorId: req.user.id, action: "employee_create",
      entityType: "user", entityId: id, next: { email: b.email },
    });
    return { id };
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e.message))) throw new Error("Email already in use");
    throw e;
  }
}));

app.patch("/api/employees/:id", requireAuth, requireAdmin, handle(async (req) => {
  const target = await db.get("SELECT * FROM users WHERE id = ?", req.params.id);
  if (!target || target.organization_id !== req.orgId) throw new Error("Employee not found");
  if (req.body?.pin) await assertPinFree(req.orgId, req.body.pin, target.id);
  const allowed = ["first_name", "last_name", "phone", "pin", "role", "job_role_id",
    "department_id", "location_id", "manager_id", "leave_balance", "active"];
  const sets = [], vals = [], prev = {}, next = {};
  for (const k of allowed) {
    if (k in (req.body || {})) {
      sets.push(`${k} = ?`); vals.push(req.body[k]);
      prev[k] = target[k]; next[k] = req.body[k];
    }
  }
  if (!sets.length) throw new Error("Nothing to update");
  await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...vals, req.params.id);
  if ("extra_location_ids" in (req.body || {})) {
    await db.run("DELETE FROM employee_locations WHERE user_id = ?", req.params.id);
    for (const lid of req.body.extra_location_ids || []) {
      await db.run(
        "INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        req.params.id, lid
      );
    }
  }
  await audit({
    orgId: req.orgId, actorId: req.user.id, action: "employee_update",
    entityType: "user", entityId: Number(req.params.id), previous: prev, next,
  });
  return { ok: true };
}));

app.get("/api/directory", requireAuth, handle(async (req) => ({
  locations: await db.all("SELECT * FROM locations WHERE organization_id = ? AND active = 1 ORDER BY name", req.orgId),
  job_roles: await db.all("SELECT * FROM job_roles WHERE organization_id = ? AND active = 1 ORDER BY name", req.orgId),
  departments: await db.all("SELECT * FROM departments WHERE organization_id = ? ORDER BY name", req.orgId),
})));

// ---------------------------------------------------------------- admin: settings & config
app.get("/api/admin/settings", requireAuth, requireAdmin, handle(async (req) => ({
  settings: await getSettings(req.orgId), defaults: DEFAULT_SETTINGS,
})));
app.put("/api/admin/settings", requireAuth, requireAdmin, handle(async (req) => {
  const prev = await getSettings(req.orgId);
  for (const [k, v] of Object.entries(req.body || {})) await setSetting(req.orgId, k, v);
  await audit({
    orgId: req.orgId, actorId: req.user.id, action: "settings_update",
    entityType: "settings", previous: prev, next: req.body,
  });
  return { settings: await getSettings(req.orgId) };
}));

app.post("/api/admin/job-roles", requireAuth, requireAdmin, handle(async (req) => {
  const id = await insert("INSERT INTO job_roles (organization_id, name) VALUES (?, ?)", req.orgId, req.body?.name);
  await audit({ orgId: req.orgId, actorId: req.user.id, action: "job_role_create", entityType: "job_role", entityId: id, next: { name: req.body?.name } });
  return { id };
}));
app.post("/api/admin/departments", requireAuth, requireAdmin, handle(async (req) => ({
  id: await insert("INSERT INTO departments (organization_id, name) VALUES (?, ?)", req.orgId, req.body?.name),
})));
app.post("/api/admin/locations", requireAuth, requireAdmin, handle(async (req) => {
  const b = req.body || {};
  const id = await insert(`
    INSERT INTO locations (organization_id, name, address, latitude, longitude, attendance_radius_meters)
    VALUES (?, ?, ?, ?, ?, ?)
  `, req.orgId, b.name, b.address || "", b.latitude ?? null, b.longitude ?? null, b.attendance_radius_meters || 150);
  await audit({ orgId: req.orgId, actorId: req.user.id, action: "location_create", entityType: "location", entityId: id, next: b });
  return { id };
}));

app.get("/api/admin/checkpoints", requireAuth, requireAdmin, handle(async (req) => ({
  checkpoints: await db.all(`
    SELECT c.*, l.name AS location_name FROM attendance_checkpoints c
    JOIN locations l ON l.id = c.location_id WHERE c.organization_id = ? ORDER BY l.name, c.name
  `, req.orgId),
  kiosks: await db.all(`
    SELECT k.*, l.name AS location_name FROM kiosk_devices k
    JOIN locations l ON l.id = k.location_id WHERE k.organization_id = ? ORDER BY l.name, k.name
  `, req.orgId),
})));
app.post("/api/admin/checkpoints", requireAuth, requireAdmin, handle(async (req) => createCheckpoint(req.user, req.body || {})));
app.patch("/api/admin/checkpoints/:id", requireAuth, requireAdmin, handle(async (req) => {
  const cp = await db.get("SELECT * FROM attendance_checkpoints WHERE id = ?", req.params.id);
  if (!cp || cp.organization_id !== req.orgId) throw new Error("Checkpoint not found");
  const name = String(req.body?.name || "").trim();
  if (!name) throw new Error("Name required");
  await db.run("UPDATE attendance_checkpoints SET name = ? WHERE id = ?", name, cp.id);
  await audit({
    orgId: req.orgId, actorId: req.user.id, action: "checkpoint_rename",
    entityType: "attendance_checkpoint", entityId: cp.id,
    previous: { name: cp.name }, next: { name },
  });
  return { ok: true };
}));
app.post("/api/admin/kiosks", requireAuth, requireAdmin, handle(async (req) => createKiosk(req.user, req.body || {})));
app.post("/api/admin/kiosks/:id/reset", requireAuth, requireAdmin, handle(async (req) => resetKiosk(req.user, Number(req.params.id))));

app.get("/api/admin/staffing-requirements", requireAuth, requireManager, handle(async (req) => ({
  requirements: await db.all(`
    SELECT sr.*, jr.name AS role_name, l.name AS location_name FROM staffing_requirements sr
    JOIN job_roles jr ON jr.id = sr.job_role_id
    JOIN locations l ON l.id = sr.location_id
    WHERE sr.organization_id = ? ORDER BY sr.weekday, sr.start_time
  `, req.orgId),
})));
app.post("/api/admin/staffing-requirements", requireAuth, requireAdmin, handle(async (req) => {
  const b = req.body || {};
  const id = await insert(`
    INSERT INTO staffing_requirements (organization_id, location_id, weekday, start_time, end_time, job_role_id, required_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, req.orgId, b.location_id, b.weekday, b.start_time, b.end_time, b.job_role_id, b.required_count || 1);
  await audit({ orgId: req.orgId, actorId: req.user.id, action: "staffing_requirement_create", entityType: "staffing_requirement", entityId: id, next: b });
  return { id };
}));
app.delete("/api/admin/staffing-requirements/:id", requireAuth, requireAdmin, handle(async (req) => {
  const row = await db.get("SELECT * FROM staffing_requirements WHERE id = ? AND organization_id = ?", req.params.id, req.orgId);
  if (!row) throw new Error("Not found");
  await db.run("DELETE FROM staffing_requirements WHERE id = ?", req.params.id);
  await audit({ orgId: req.orgId, actorId: req.user.id, action: "staffing_requirement_delete", entityType: "staffing_requirement", entityId: row.id, previous: row });
  return { ok: true };
}));

app.get("/api/admin/audit", requireAuth, requireAdmin, handle(async (req) => ({
  entries: await db.all(`
    SELECT a.*, u.first_name, u.last_name FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.organization_id = ? ORDER BY a.id DESC LIMIT 100
  `, req.orgId),
})));

// ---------------------------------------------------------------- reports
app.get("/api/reports/monthly", requireAuth, requireManager, handle(async (req) => ({
  month: req.query.month || todayStr().slice(0, 7),
  rows: await attendanceReport(req.orgId, req.query.month || todayStr().slice(0, 7), {
    locationId: Number(req.query.location_id) || null,
    jobRoleId: Number(req.query.job_role_id) || null,
  }),
})));
app.get("/api/reports/leave", requireAuth, requireManager, handle(async (req) => ({
  year: req.query.year || todayStr().slice(0, 4),
  rows: await leaveReport(req.orgId, req.query.year || todayStr().slice(0, 4)),
})));
app.get("/api/reports/staffing", requireAuth, requireManager, handle(async (req) => {
  const start = req.query.start || mondayOf(todayStr());
  const end = req.query.end || addDays(start, 6);
  return { start, end, rows: await staffingReport(req.orgId, start, end) };
}));

// ---------------------------------------------------------------- static (prod)
if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = process.env.API_PORT || 4180;
// On Vercel the app is exported as a serverless handler (api/index.js) — never listen there.
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`TapTime API listening on http://localhost:${PORT}`));
}
export { app };
