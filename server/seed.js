// Seeds a realistic dental clinic on schema v2. Run: npm run seed
// Recreates the database from scratch (dev/demo data only).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.TAPTIME_DB || path.join(__dirname, "taptime.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(dbFile + suffix); } catch { /* fresh */ }
}

const { db } = await import("./db.js");
const { hashPassword } = await import("./auth.js");
const { todayStr, addDays, mondayOf, dateTimeIso, nowIso, businessDays, shiftMinutes, minutesBetween } =
  await import("./time.js");

const now = nowIso();

// --- organization ----------------------------------------------------------
const orgId = db.prepare(`
  INSERT INTO organizations (name, slug, timezone, created_at, updated_at)
  VALUES ('Zâmbet Dental', 'zambet-dental', 'Europe/Bucharest', ?, ?)
`).run(now, now).lastInsertRowid;

// --- locations (real-ish Bucharest coordinates for geo checks) -------------
const insLoc = db.prepare(`
  INSERT INTO locations (organization_id, name, address, latitude, longitude, attendance_radius_meters)
  VALUES (?, ?, ?, ?, ?, 150)
`);
const central = insLoc.run(orgId, "Central Clinic", "Str. Dorobanți 24, București", 44.4531, 26.0982).lastInsertRowid;
const pipera = insLoc.run(orgId, "Pipera Clinic", "Bd. Pipera 41, București", 44.4972, 26.1213).lastInsertRowid;

// --- job roles (configurable, plan 2.3) ------------------------------------
const insRole = db.prepare("INSERT INTO job_roles (organization_id, name) VALUES (?, ?)");
const ROLE_NAMES = ["Dentist", "Dental Assistant", "Dental Hygienist", "Receptionist",
  "Clinic Manager", "Head Dentist", "Administrator", "Support Staff"];
const roleId = {};
for (const r of ROLE_NAMES) roleId[r] = insRole.run(orgId, r).lastInsertRowid;

const insDept = db.prepare("INSERT INTO departments (organization_id, name) VALUES (?, ?)");
const deptId = {};
for (const d of ["Clinical", "Front Desk", "Operations"]) deptId[d] = insDept.run(orgId, d).lastInsertRowid;
const deptFor = (job) =>
  job === "Receptionist" ? deptId["Front Desk"]
  : ["Administrator", "Support Staff", "Clinic Manager"].includes(job) ? deptId.Operations
  : deptId.Clinical;

// --- users -----------------------------------------------------------------
const pw = hashPassword("taptime123");
const insUser = db.prepare(`
  INSERT INTO users (organization_id, first_name, last_name, email, phone, password_hash, pin, role,
                     job_role_id, department_id, location_id, manager_id, employment_start, leave_balance)
  VALUES (@org, @first, @last, @email, @phone, @hash, @pin, @role, @jobRole, @dept, @loc, @manager, '2023-03-01', 21)
`);
function addUser(u) {
  return insUser.run({
    org: orgId, hash: pw, manager: null,
    phone: "07" + String(20000000 + Math.floor(Math.random() * 9999999)),
    dept: deptFor(u.job), jobRole: roleId[u.job], ...u,
  }).lastInsertRowid;
}

const admin = addUser({
  first: "Ioana", last: "Vasilescu", email: "admin@taptime.app",
  pin: "0000", role: "admin", job: "Administrator", loc: central,
});
const manager = addUser({
  first: "Andrei", last: "Popescu", email: "manager@taptime.app",
  pin: "1111", role: "manager", job: "Head Dentist", loc: central, manager: admin,
});

const staff = [
  ["Radu", "Ionescu", "Dentist", central, "2222"],
  ["Cristina", "Marin", "Dentist", central, "2223"],
  ["Vlad", "Dumitru", "Dentist", pipera, "2224"],
  ["Ana", "Georgescu", "Dental Assistant", central, "3331"],
  ["Elena", "Stancu", "Dental Assistant", central, "3332"],
  ["Bianca", "Petrescu", "Dental Assistant", pipera, "3333"],
  ["Simona", "Radu", "Dental Hygienist", central, "4441"],
  ["Larisa", "Enache", "Dental Hygienist", pipera, "4442"],
  ["Maria", "Constantin", "Receptionist", central, "5551"],
  ["Diana", "Toma", "Receptionist", pipera, "5552"],
  ["Gheorghe", "Nistor", "Support Staff", central, "6661"],
];
const staffIds = staff.map(([first, last, job, loc, pin]) =>
  addUser({
    first, last, job, loc, pin, role: "employee", manager,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@taptime.app`,
  })
);
const everyone = [manager, ...staffIds];

// A couple of people float between both clinics (plan Phase 3).
const insEL = db.prepare("INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?)");
insEL.run(staffIds[0], pipera);   // Radu also works at Pipera
insEL.run(staffIds[7], central);  // Larisa also works at Central

// --- checkpoints & kiosks --------------------------------------------------
const insCp = db.prepare(`
  INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
  VALUES (?, ?, ?, ?, ?)
`);
insCp.run(orgId, central, "Main Entrance QR", "QR", "central-main");
insCp.run(orgId, central, "Staff Entrance NFC", "NFC", "central-staff");
insCp.run(orgId, pipera, "Reception QR", "QR", "pipera-main");

db.prepare(`
  INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
  VALUES (?, ?, 'Reception iPad — Central', 'DEMO1234')
`).run(orgId, central);
db.prepare(`
  INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
  VALUES (?, ?, 'Reception iPad — Pipera', 'DEMO5678')
`).run(orgId, pipera);

// --- staffing requirements (weekdays, plan Phase 5) ------------------------
const insReq = db.prepare(`
  INSERT INTO staffing_requirements (organization_id, location_id, weekday, start_time, end_time, job_role_id, required_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
for (let wd = 0; wd < 5; wd++) {
  insReq.run(orgId, central, wd, "08:00", "14:00", roleId["Dentist"], 2);
  insReq.run(orgId, central, wd, "08:00", "14:00", roleId["Dental Assistant"], 2);
  insReq.run(orgId, central, wd, "08:00", "20:00", roleId["Receptionist"], 1);
  insReq.run(orgId, central, wd, "14:00", "20:00", roleId["Dentist"], 1);
  insReq.run(orgId, pipera, wd, "08:00", "16:00", roleId["Dentist"], 1);
  insReq.run(orgId, pipera, wd, "08:00", "16:00", roleId["Dental Assistant"], 1);
  insReq.run(orgId, pipera, wd, "08:00", "16:00", roleId["Receptionist"], 1);
}

// --- shifts: 2 weeks back through 2 weeks ahead, Mon-Fri -------------------
const insShift = db.prepare(`
  INSERT INTO shifts (organization_id, user_id, date, start_time, end_time, location_id, job_role_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const userRow = db.prepare("SELECT * FROM users WHERE id = ?");
const today = todayStr();
const startMonday = addDays(mondayOf(today), -14);

const patterns = {
  [roleId["Dentist"]]: [["08:00", "16:00"], ["10:00", "18:00"]],
  [roleId["Dental Assistant"]]: [["08:00", "16:00"], ["09:00", "17:00"]],
  [roleId["Dental Hygienist"]]: [["09:00", "17:00"]],
  [roleId["Receptionist"]]: [["08:00", "16:00"], ["12:00", "20:00"]],
  [roleId["Support Staff"]]: [["07:00", "15:00"]],
  [roleId["Head Dentist"]]: [["08:00", "16:00"]],
};

for (let w = 0; w < 5; w++) {
  for (let d = 0; d < 5; d++) {
    const date = addDays(startMonday, w * 7 + d);
    everyone.forEach((id, i) => {
      if ((i + w) % 6 === d % 6 && d === (i % 5)) return; // weekly day off
      const u = userRow.get(id);
      const opts = patterns[u.job_role_id] || [["08:00", "16:00"]];
      const [start, end] = opts[(i + d) % opts.length];
      insShift.run(orgId, id, date, start, end, u.location_id, u.job_role_id);
    });
  }
}

// --- past attendance with persisted totals ---------------------------------
const insAtt = db.prepare(`
  INSERT INTO attendance (organization_id, user_id, shift_id, date, clock_in, clock_out,
                          clock_in_method, clock_out_method, location_id, status,
                          worked_minutes, break_minutes, overtime_minutes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
`);
const insBreak = db.prepare("INSERT INTO breaks (attendance_id, start, end) VALUES (?, ?, ?)");
const insOt = db.prepare(`
  INSERT INTO overtime (organization_id, user_id, date, minutes, status, created_at)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);
const jitter = (spread) => Math.floor(Math.random() * spread * 2) - spread;
const shiftTime = (date, time, offsetMin) =>
  new Date(new Date(dateTimeIso(date, time)).getTime() + offsetMin * 60000).toISOString();

const methods = ["WEB", "QR", "KIOSK", "WEB", "QR"];
for (const s of db.prepare("SELECT * FROM shifts WHERE date < ?").all(today)) {
  const r = Math.random();
  if (r < 0.04) continue; // occasional absence
  const inIso = shiftTime(s.date, s.start_time, jitter(8));
  let outMin = jitter(10), overtime = 0;
  if (r > 0.92) { overtime = 45 + Math.floor(Math.random() * 90); outMin = overtime; }
  const outIso = shiftTime(s.date, s.end_time, outMin);
  const brStart = shiftTime(s.date, "12:30", jitter(20));
  const brDur = 25 + Math.floor(Math.random() * 15);
  const brEnd = new Date(new Date(brStart).getTime() + brDur * 60000).toISOString();
  const worked = Math.max(0, minutesBetween(inIso, outIso) - brDur);
  const ot = Math.max(0, worked - shiftMinutes(s.start_time, s.end_time));
  const method = methods[Math.floor(Math.random() * methods.length)];
  const attId = insAtt.run(
    orgId, s.user_id, s.id, s.date, inIso, outIso, method, method,
    s.location_id, worked, brDur, ot, inIso, outIso
  ).lastInsertRowid;
  insBreak.run(attId, brStart, brEnd);
  if (overtime > 30) insOt.run(orgId, s.user_id, s.date, ot, nowIso());
}

// --- today: some clocked in, one on break, one flagged high-risk -----------
const insOpenAtt = db.prepare(`
  INSERT INTO attendance (organization_id, user_id, shift_id, date, clock_in, clock_in_method,
                          location_id, status, risk_level, risk_signals, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const todayShifts = db.prepare("SELECT * FROM shifts WHERE date = ?").all(today);
todayShifts.forEach((s, i) => {
  const startIso = dateTimeIso(s.date, s.start_time);
  if (new Date(startIso) > new Date()) return;
  if (i % 7 === 3) return; // late / absent
  const inIso = shiftTime(s.date, s.start_time, jitter(6));
  const risky = i % 9 === 5;
  const attId = insOpenAtt.run(
    orgId, s.user_id, s.id, s.date, inIso, risky ? "WEB" : ["WEB", "QR", "KIOSK"][i % 3],
    s.location_id, risky ? "requires_review" : "working",
    risky ? "high" : "low", risky ? JSON.stringify(["location_mismatch:820m", "unknown_device"]) : "[]",
    inIso, inIso
  ).lastInsertRowid;
  if (risky) {
    db.prepare(`
      INSERT INTO attendance_flags (organization_id, attendance_id, user_id, kind, detail, risk_level, created_at)
      VALUES (?, ?, ?, 'location_mismatch', '820m from Central Clinic, unknown device', 'high', ?)
    `).run(orgId, attId, s.user_id, nowIso());
  }
  if (i % 5 === 2) insBreak.run(attId, new Date(Date.now() - 12 * 60000).toISOString(), null);
});

// --- pending requests ------------------------------------------------------
const insCorr = db.prepare(`
  INSERT INTO corrections (organization_id, user_id, date, kind, requested_in, requested_out, reason, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
`);
insCorr.run(orgId, staffIds[3], addDays(today, -1), "missing_out", "", "16:05", "I forgot to clock out.", nowIso());
insCorr.run(orgId, staffIds[8], addDays(today, -2), "missing_in", "07:55", "", "Terminal was busy, went straight to reception.", nowIso());

const insLeave = db.prepare(`
  INSERT INTO leave_requests (organization_id, user_id, type, start_date, end_date, days, note, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const l1s = addDays(today, 7), l1e = addDays(today, 9);
insLeave.run(orgId, staffIds[8], "annual", l1s, l1e, businessDays(l1s, l1e), "Family trip", "pending", nowIso());
const l2s = addDays(today, 3), l2e = addDays(today, 3);
insLeave.run(orgId, staffIds[1], "personal", l2s, l2e, 1, "", "pending", nowIso());
const l3s = addDays(today, -10), l3e = addDays(today, -8);
insLeave.run(orgId, staffIds[5], "medical", l3s, l3e, businessDays(l3s, l3e), "Medical certificate attached", "approved", nowIso());

console.log("Seeded TapTime v2 (org: Zâmbet Dental).");
console.log("Logins (password: taptime123): admin@taptime.app · manager@taptime.app · ana.georgescu@taptime.app");
console.log("Kiosk setup codes: DEMO1234 (Central) · DEMO5678 (Pipera)");
console.log("Checkpoint demo URL: /checkpoint/central-main");
