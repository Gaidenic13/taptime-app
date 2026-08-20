import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";
import { audit } from "./audit.js";
import { getSettings, setSetting, DEFAULT_SETTINGS } from "./settings.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  requireAuth, requireManager, requireAdmin, touchDevice, registerKiosk, requireKiosk,
} from "./auth.js";
import { dayStatus, clockIn, clockOut, breakAction, resolveReview } from "./domains/attendance.js";
import { createShift, deleteShift, weekShifts } from "./domains/scheduling.js";
import { coverageFor } from "./domains/staffing.js";
import {
  requestLeave, requestCorrection, pendingApprovals, decide, resolveFlag,
} from "./domains/requests.js";
import {
  checkpointByCode, createChallenge, consumeChallenge, createCheckpoint, createKiosk, resetKiosk,
} from "./domains/checkpoints.js";
import { listNotifications, unreadCount, markAllRead } from "./domains/notifications.js";
import { attendanceReport, leaveReport, staffingReport } from "./domains/reports.js";
import { todayStr, mondayOf, addDays, workedMinutes, breakMinutes } from "./time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

function publicUser(u) {
  if (!u) return null;
  const { password_hash, pin, ...rest } = u;
  const jr = rest.job_role_id
    ? db.prepare("SELECT name FROM job_roles WHERE id = ?").get(rest.job_role_id) : null;
  rest.job_title = jr?.name || "—";
  return rest;
}

const handle = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

// ---------------------------------------------------------------- auth
app.post("/api/auth/login", handle((req) => {
  const { email, password } = req.body || {};
  const user = email
    ? db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email.trim().toLowerCase())
    : null;
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    const err = new Error("Invalid email or password"); err.status = 401; throw err;
  }
  const token = createSession(user.id);
  touchDevice(user.id, req.headers["x-device-token"], req.headers["user-agent"]);
  audit({ orgId: user.organization_id, actorId: user.id, action: "login" });
  return { token, user: publicUser(user) };
}));

app.post("/api/auth/logout", requireAuth, handle((req) => {
  destroySession(req.token);
  return { ok: true };
}));

app.get("/api/me", requireAuth, handle((req) => {
  touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  return {
    user: publicUser(req.user),
    today: dayStatus(req.user.id, todayStr()),
    unread_notifications: unreadCount(req.user.id),
  };
}));

// ---------------------------------------------------------------- clock actions (web)
app.post("/api/attendance/clock-in", requireAuth, handle((req) => {
  const { known } = touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  return {
    today: clockIn(req.user, {
      method: "WEB", locationId: req.body?.location_id || null,
      geo: req.body?.geo || null, deviceKnown: known,
    }),
  };
}));
app.post("/api/attendance/clock-out", requireAuth, handle((req) => ({
  today: clockOut(req.user, { method: "WEB", locationId: req.body?.location_id || null }),
})));
app.post("/api/attendance/break-start", requireAuth, handle((req) => ({ today: breakAction(req.user, "start") })));
app.post("/api/attendance/break-end", requireAuth, handle((req) => ({ today: breakAction(req.user, "end") })));

// ---------------------------------------------------------------- checkpoint flow (QR/NFC)
// Public: reaching a checkpoint creates a short-lived challenge. Identity comes
// from the session that consumes it — the code alone never clocks anyone in.
app.get("/api/checkpoint/:code", handle((req) => {
  const cp = checkpointByCode(req.params.code);
  if (!cp) { const e = new Error("Checkpoint not found"); e.status = 404; throw e; }
  const ch = createChallenge(cp);
  return {
    challenge: ch.token, expires_in: ch.expires_in,
    checkpoint: { name: cp.name, type: cp.type, location: cp.location_name },
  };
}));

app.post("/api/checkpoint/consume", requireAuth, handle((req) => {
  const { challenge, action, geo } = req.body || {};
  const cp = consumeChallenge(challenge, req.user);
  if (!cp) { const e = new Error("This code has expired — tap or scan again"); e.status = 410; throw e; }
  const { known } = touchDevice(req.user.id, req.deviceToken, req.headers["user-agent"]);
  const opts = { method: cp.type, locationId: cp.location_id, geo: geo || null, viaCheckpoint: true, deviceKnown: known };
  if (action === "clock-out") return { today: clockOut(req.user, { method: cp.type, locationId: cp.location_id }) };
  return { today: clockIn(req.user, opts) };
}));

// ---------------------------------------------------------------- kiosk (restricted session)
app.post("/api/kiosk/register", handle((req) => registerKiosk(req.body?.setup_code)));

app.post("/api/kiosk/pin", requireKiosk, handle((req) => {
  const user = db.prepare(
    "SELECT * FROM users WHERE pin = ? AND pin != '' AND active = 1 AND organization_id = ?"
  ).get(String(req.body?.pin || ""), req.orgId);
  if (!user) { const e = new Error("PIN not recognized"); e.status = 401; throw e; }
  return { user: publicUser(user), today: dayStatus(user.id, todayStr()) };
}));

app.post("/api/kiosk/:action", requireKiosk, handle((req) => {
  const user = db.prepare(
    "SELECT * FROM users WHERE pin = ? AND pin != '' AND active = 1 AND organization_id = ?"
  ).get(String(req.body?.pin || ""), req.orgId);
  if (!user) { const e = new Error("PIN not recognized"); e.status = 401; throw e; }
  const map = {
    "clock-in": () => clockIn(user, { method: "KIOSK", locationId: req.kiosk.location_id, deviceKnown: true }),
    "clock-out": () => clockOut(user, { method: "KIOSK", locationId: req.kiosk.location_id }),
    "break-start": () => breakAction(user, "start"),
    "break-end": () => breakAction(user, "end"),
  };
  const fn = map[req.params.action];
  if (!fn) { const e = new Error("Unknown action"); e.status = 404; throw e; }
  return { user: publicUser(user), today: fn() };
}));

// ---------------------------------------------------------------- my attendance
app.get("/api/attendance/history", requireAuth, handle((req) => {
  const month = req.query.month || todayStr().slice(0, 7);
  const userId = Number(req.query.user_id) || req.user.id;
  if (userId !== req.user.id && req.user.role === "employee") {
    const e = new Error("Forbidden"); e.status = 403; throw e;
  }
  if (userId !== req.user.id) {
    const target = db.prepare("SELECT organization_id FROM users WHERE id = ?").get(userId);
    if (!target || target.organization_id !== req.orgId) { const e = new Error("Forbidden"); e.status = 403; throw e; }
  }
  const shifts = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND date LIKE ? ORDER BY date").all(userId, `${month}%`);
  const atts = db.prepare("SELECT * FROM attendance WHERE user_id = ? AND date LIKE ? ORDER BY date").all(userId, `${month}%`);
  const leaves = db.prepare(
    "SELECT * FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?"
  ).all(userId, `${month}-31`, `${month}-01`);
  const corrections = db.prepare("SELECT * FROM corrections WHERE user_id = ? AND date LIKE ?").all(userId, `${month}%`);

  const byDate = {};
  for (const s of shifts) byDate[s.date] = { date: s.date, shift: s };
  for (const a of atts) {
    byDate[a.date] = byDate[a.date] || { date: a.date };
    const breaks = db.prepare("SELECT * FROM breaks WHERE attendance_id = ?").all(a.id);
    byDate[a.date].attendance = a;
    byDate[a.date].breaks = breaks;
    byDate[a.date].worked_min = a.worked_minutes ?? workedMinutes(a, breaks);
    byDate[a.date].break_min = a.break_minutes ?? breakMinutes(breaks);
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
app.get("/api/schedule", requireAuth, handle((req) => {
  const week = req.query.week || mondayOf(todayStr());
  const scopeAll = req.query.all === "1" && req.user.role !== "employee";
  const filters = scopeAll
    ? {
        locationId: Number(req.query.location_id) || null,
        jobRoleId: Number(req.query.job_role_id) || null,
        userId: Number(req.query.user_id) || null,
      }
    : { userId: req.user.id };
  return { week, shifts: weekShifts(req.orgId, week, addDays(week, 6), filters) };
}));

app.post("/api/schedule", requireAuth, requireManager, handle((req) => {
  const b = req.body || {};
  if (!b.user_id || !b.date || !b.start_time || !b.end_time) {
    throw new Error("user_id, date, start_time, end_time required");
  }
  return { id: createShift(req.user, b) };
}));

app.delete("/api/schedule/:id", requireAuth, requireManager, handle((req) => {
  deleteShift(req.user, Number(req.params.id));
  return { ok: true };
}));

// ---------------------------------------------------------------- corrections & leave
app.post("/api/corrections", requireAuth, handle((req) => ({ id: requestCorrection(req.user, req.body || {}) })));
app.get("/api/corrections", requireAuth, handle((req) => ({
  corrections: db.prepare(
    "SELECT * FROM corrections WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(req.user.id),
})));

app.get("/api/leave", requireAuth, handle((req) => ({
  balance: req.user.leave_balance,
  requests: db.prepare(
    "SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(req.user.id),
})));
app.post("/api/leave", requireAuth, handle((req) => requestLeave(req.user, req.body || {})));

// ---------------------------------------------------------------- team & approvals (manager)
app.get("/api/team/today", requireAuth, requireManager, handle((req) => {
  const date = req.query.date || todayStr();
  const users = db.prepare(`
    SELECT u.*, jr.name AS job_title, l.name AS location_name FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = u.location_id
    WHERE u.organization_id = ? AND u.active = 1 ORDER BY jr.name, u.last_name
  `).all(req.orgId);
  const roster = users.map((u) => {
    const d = dayStatus(u.id, date);
    return {
      id: u.id, name: `${u.first_name} ${u.last_name}`, job_title: u.job_title || "—",
      location: u.location_name, status: d.status,
      shift: d.shift ? `${d.shift.start_time}–${d.shift.end_time}` : null,
      clock_in: d.attendance?.clock_in || null,
      risk: d.attendance?.risk_level || null,
      worked_min: d.worked_min,
    };
  });
  const counts = {};
  for (const r of roster) counts[r.status] = (counts[r.status] || 0) + 1;

  const coverage = {};
  for (const r of roster) {
    if (!r.shift) continue;
    coverage[r.job_title] = coverage[r.job_title] || { scheduled: 0, present: 0 };
    coverage[r.job_title].scheduled++;
    if (["working", "break", "complete"].includes(r.status)) coverage[r.job_title].present++;
  }

  const staffing = coverageFor(req.orgId, date);
  const pending = pendingApprovals(req.orgId);
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

app.get("/api/approvals", requireAuth, requireManager, handle((req) => pendingApprovals(req.orgId)));
app.post("/api/approvals/:type/:id", requireAuth, requireManager, handle((req) => {
  decide(req.user, req.params.type, req.params.id, req.body?.decision, req.body?.note || "");
  return { ok: true };
}));
app.post("/api/reviews/:attendanceId", requireAuth, requireManager, handle((req) => {
  resolveReview(req.user, Number(req.params.attendanceId), req.body?.decision, req.body?.note || "");
  return { ok: true };
}));
app.post("/api/flags/:id/resolve", requireAuth, requireManager, handle((req) => {
  resolveFlag(req.user, Number(req.params.id), req.body?.note || "");
  return { ok: true };
}));

// ---------------------------------------------------------------- notifications
app.get("/api/notifications", requireAuth, handle((req) => ({
  unread: unreadCount(req.user.id),
  notifications: listNotifications(req.user.id),
})));
app.post("/api/notifications/read-all", requireAuth, handle((req) => {
  markAllRead(req.user.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- org directory
app.get("/api/employees", requireAuth, requireManager, handle((req) => ({
  employees: db.prepare(`
    SELECT u.*, jr.name AS job_title, l.name AS location_name, d.name AS department_name FROM users u
    LEFT JOIN job_roles jr ON jr.id = u.job_role_id
    LEFT JOIN locations l ON l.id = u.location_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.organization_id = ? ORDER BY u.active DESC, u.last_name
  `).all(req.orgId).map((u) => { const { password_hash, pin, ...rest } = u; return { ...rest, pin }; }),
})));

app.post("/api/employees", requireAuth, requireAdmin, handle((req) => {
  const b = req.body || {};
  if (!b.first_name || !b.last_name || !b.email) throw new Error("first_name, last_name, email required");
  try {
    const info = db.prepare(`
      INSERT INTO users (organization_id, first_name, last_name, email, phone, password_hash, pin, role,
                         job_role_id, department_id, location_id, manager_id, employment_start, leave_balance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.orgId, b.first_name, b.last_name, b.email.trim().toLowerCase(), b.phone || "",
      hashPassword(b.password || "taptime123"), b.pin || "", b.role || "employee",
      b.job_role_id || null, b.department_id || null, b.location_id || null,
      b.manager_id || req.user.id, b.employment_start || todayStr(), b.leave_balance ?? 21
    );
    audit({
      orgId: req.orgId, actorId: req.user.id, action: "employee_create",
      entityType: "user", entityId: info.lastInsertRowid, next: { email: b.email },
    });
    return { id: info.lastInsertRowid };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new Error("Email already in use");
    throw e;
  }
}));

app.patch("/api/employees/:id", requireAuth, requireAdmin, handle((req) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target || target.organization_id !== req.orgId) throw new Error("Employee not found");
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
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, req.params.id);
  if ("extra_location_ids" in (req.body || {})) {
    db.prepare("DELETE FROM employee_locations WHERE user_id = ?").run(req.params.id);
    for (const lid of req.body.extra_location_ids || []) {
      db.prepare("INSERT OR IGNORE INTO employee_locations (user_id, location_id) VALUES (?, ?)").run(req.params.id, lid);
    }
  }
  audit({
    orgId: req.orgId, actorId: req.user.id, action: "employee_update",
    entityType: "user", entityId: Number(req.params.id), previous: prev, next,
  });
  return { ok: true };
}));

app.get("/api/directory", requireAuth, handle((req) => ({
  locations: db.prepare("SELECT * FROM locations WHERE organization_id = ? AND active = 1 ORDER BY name").all(req.orgId),
  job_roles: db.prepare("SELECT * FROM job_roles WHERE organization_id = ? AND active = 1 ORDER BY name").all(req.orgId),
  departments: db.prepare("SELECT * FROM departments WHERE organization_id = ? ORDER BY name").all(req.orgId),
})));

// ---------------------------------------------------------------- admin: settings & config
app.get("/api/admin/settings", requireAuth, requireAdmin, handle((req) => ({
  settings: getSettings(req.orgId), defaults: DEFAULT_SETTINGS,
})));
app.put("/api/admin/settings", requireAuth, requireAdmin, handle((req) => {
  const prev = getSettings(req.orgId);
  for (const [k, v] of Object.entries(req.body || {})) setSetting(req.orgId, k, v);
  audit({
    orgId: req.orgId, actorId: req.user.id, action: "settings_update",
    entityType: "settings", previous: prev, next: req.body,
  });
  return { settings: getSettings(req.orgId) };
}));

app.post("/api/admin/job-roles", requireAuth, requireAdmin, handle((req) => {
  const info = db.prepare("INSERT INTO job_roles (organization_id, name) VALUES (?, ?)").run(req.orgId, req.body?.name);
  audit({ orgId: req.orgId, actorId: req.user.id, action: "job_role_create", entityType: "job_role", entityId: info.lastInsertRowid, next: { name: req.body?.name } });
  return { id: info.lastInsertRowid };
}));
app.post("/api/admin/departments", requireAuth, requireAdmin, handle((req) => {
  const info = db.prepare("INSERT INTO departments (organization_id, name) VALUES (?, ?)").run(req.orgId, req.body?.name);
  return { id: info.lastInsertRowid };
}));
app.post("/api/admin/locations", requireAuth, requireAdmin, handle((req) => {
  const b = req.body || {};
  const info = db.prepare(`
    INSERT INTO locations (organization_id, name, address, latitude, longitude, attendance_radius_meters)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.orgId, b.name, b.address || "", b.latitude ?? null, b.longitude ?? null, b.attendance_radius_meters || 150);
  audit({ orgId: req.orgId, actorId: req.user.id, action: "location_create", entityType: "location", entityId: info.lastInsertRowid, next: b });
  return { id: info.lastInsertRowid };
}));

app.get("/api/admin/checkpoints", requireAuth, requireAdmin, handle((req) => ({
  checkpoints: db.prepare(`
    SELECT c.*, l.name AS location_name FROM attendance_checkpoints c
    JOIN locations l ON l.id = c.location_id WHERE c.organization_id = ? ORDER BY l.name, c.name
  `).all(req.orgId),
  kiosks: db.prepare(`
    SELECT k.*, l.name AS location_name FROM kiosk_devices k
    JOIN locations l ON l.id = k.location_id WHERE k.organization_id = ? ORDER BY l.name, k.name
  `).all(req.orgId),
})));
app.post("/api/admin/checkpoints", requireAuth, requireAdmin, handle((req) => createCheckpoint(req.user, req.body || {})));
app.post("/api/admin/kiosks", requireAuth, requireAdmin, handle((req) => createKiosk(req.user, req.body || {})));
app.post("/api/admin/kiosks/:id/reset", requireAuth, requireAdmin, handle((req) => resetKiosk(req.user, Number(req.params.id))));

app.get("/api/admin/staffing-requirements", requireAuth, requireManager, handle((req) => ({
  requirements: db.prepare(`
    SELECT sr.*, jr.name AS role_name, l.name AS location_name FROM staffing_requirements sr
    JOIN job_roles jr ON jr.id = sr.job_role_id
    JOIN locations l ON l.id = sr.location_id
    WHERE sr.organization_id = ? ORDER BY sr.weekday, sr.start_time
  `).all(req.orgId),
})));
app.post("/api/admin/staffing-requirements", requireAuth, requireAdmin, handle((req) => {
  const b = req.body || {};
  const info = db.prepare(`
    INSERT INTO staffing_requirements (organization_id, location_id, weekday, start_time, end_time, job_role_id, required_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.orgId, b.location_id, b.weekday, b.start_time, b.end_time, b.job_role_id, b.required_count || 1);
  audit({ orgId: req.orgId, actorId: req.user.id, action: "staffing_requirement_create", entityType: "staffing_requirement", entityId: info.lastInsertRowid, next: b });
  return { id: info.lastInsertRowid };
}));
app.delete("/api/admin/staffing-requirements/:id", requireAuth, requireAdmin, handle((req) => {
  const row = db.prepare("SELECT * FROM staffing_requirements WHERE id = ? AND organization_id = ?").get(req.params.id, req.orgId);
  if (!row) throw new Error("Not found");
  db.prepare("DELETE FROM staffing_requirements WHERE id = ?").run(req.params.id);
  audit({ orgId: req.orgId, actorId: req.user.id, action: "staffing_requirement_delete", entityType: "staffing_requirement", entityId: row.id, previous: row });
  return { ok: true };
}));

app.get("/api/admin/audit", requireAuth, requireAdmin, handle((req) => ({
  entries: db.prepare(`
    SELECT a.*, u.first_name, u.last_name FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.organization_id = ? ORDER BY a.id DESC LIMIT 100
  `).all(req.orgId),
})));

// ---------------------------------------------------------------- reports
app.get("/api/reports/monthly", requireAuth, requireManager, handle((req) => ({
  month: req.query.month || todayStr().slice(0, 7),
  rows: attendanceReport(req.orgId, req.query.month || todayStr().slice(0, 7), {
    locationId: Number(req.query.location_id) || null,
    jobRoleId: Number(req.query.job_role_id) || null,
  }),
})));
app.get("/api/reports/leave", requireAuth, requireManager, handle((req) => ({
  year: req.query.year || todayStr().slice(0, 4),
  rows: leaveReport(req.orgId, req.query.year || todayStr().slice(0, 4)),
})));
app.get("/api/reports/staffing", requireAuth, requireManager, handle((req) => {
  const start = req.query.start || mondayOf(todayStr());
  const end = req.query.end || addDays(start, 6);
  return { start, end, rows: staffingReport(req.orgId, start, end) };
}));

// ---------------------------------------------------------------- static (prod)
if (process.env.NODE_ENV === "production") {
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
