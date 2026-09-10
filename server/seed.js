// Seeds a realistic dental clinic (dev/demo data). Works on both drivers:
//   npm run seed                     → local SQLite (recreates the file)
//   DATABASE_URL=... npm run seed    → hosted PostgreSQL (clears + reseeds rows)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const usingPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (!usingPg) {
  const dbFile = process.env.TAPTIME_DB || path.join(__dirname, "taptime.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbFile + suffix); } catch { /* fresh */ }
  }
}

const { db, insert } = await import("./db.js");
const { hashPassword } = await import("./auth.js");
const { todayStr, addDays, mondayOf, dateTimeIso, nowIso, businessDays, shiftMinutes, minutesBetween } =
  await import("./time.js");

// Clear in reverse dependency order (needed on pg where the schema persists).
const wipe = [
  "audit_log", "notifications", "attendance_flags", "attendance_challenges",
  "overtime", "leave_requests", "corrections", "breaks", "attendance", "shifts",
  "kiosk_devices", "attendance_checkpoints", "devices", "sessions",
  "employee_locations", "settings", "users", "staffing_requirements",
  "departments", "job_roles", "locations", "organizations",
];
for (const t of wipe) await db.run(`DELETE FROM ${t}`);

const now = nowIso();

// --- organization ----------------------------------------------------------
const orgId = await insert(`
  INSERT INTO organizations (name, slug, timezone, created_at, updated_at)
  VALUES ('Zâmbet Dental', 'zambet-dental', 'Europe/Bucharest', ?, ?)
`, now, now);

// --- locations (real-ish Bucharest coordinates for geo checks) -------------
const addLoc = (name, address, lat, lng) => insert(`
  INSERT INTO locations (organization_id, name, address, latitude, longitude, attendance_radius_meters)
  VALUES (?, ?, ?, ?, ?, 150)
`, orgId, name, address, lat, lng);
const central = await addLoc("Central Clinic", "Str. Dorobanți 24, București", 44.4531, 26.0982);
const pipera = await addLoc("Pipera Clinic", "Bd. Pipera 41, București", 44.4972, 26.1213);

// --- job roles & departments (configurable, plan 2.3) ----------------------
const ROLE_NAMES = ["Dentist", "Dental Assistant", "Dental Hygienist", "Receptionist",
  "Clinic Manager", "Head Dentist", "Administrator", "Support Staff"];
const roleId = {};
for (const r of ROLE_NAMES) {
  roleId[r] = await insert("INSERT INTO job_roles (organization_id, name) VALUES (?, ?)", orgId, r);
}
const deptId = {};
for (const d of ["Clinical", "Front Desk", "Operations"]) {
  deptId[d] = await insert("INSERT INTO departments (organization_id, name) VALUES (?, ?)", orgId, d);
}
const deptFor = (job) =>
  job === "Receptionist" ? deptId["Front Desk"]
  : ["Administrator", "Support Staff", "Clinic Manager"].includes(job) ? deptId.Operations
  : deptId.Clinical;

// --- users -----------------------------------------------------------------
const pw = hashPassword("taptime123");
function addUser({ first, last, email, pin, role, job, loc, manager = null }) {
  return insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, phone, password_hash, pin, role,
                       job_role_id, department_id, location_id, manager_id, employment_start, leave_balance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2023-03-01', 21)
  `,
    orgId, first, last, email,
    "07" + String(20000000 + Math.floor(Math.random() * 9999999)),
    pw, pin, role, roleId[job], deptFor(job), loc, manager
  );
}

const admin = await addUser({
  first: "Ioana", last: "Vasilescu", email: "admin@taptime.app",
  pin: "0000", role: "admin", job: "Administrator", loc: central,
});
const manager = await addUser({
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
const staffIds = [];
for (const [first, last, job, loc, pin] of staff) {
  staffIds.push(await addUser({
    first, last, job, loc, pin, role: "employee", manager,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@taptime.app`,
  }));
}
const everyone = [manager, ...staffIds];

// A couple of people float between both clinics (plan Phase 3).
await db.run("INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?)", staffIds[0], pipera);
await db.run("INSERT INTO employee_locations (user_id, location_id) VALUES (?, ?)", staffIds[7], central);

// --- checkpoints & kiosks --------------------------------------------------
const addCp = (loc, name, type, code) => db.run(`
  INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
  VALUES (?, ?, ?, ?, ?)
`, orgId, loc, name, type, code);
await addCp(central, "Main Entrance QR", "QR", "central-main");
await addCp(central, "Staff Entrance NFC", "NFC", "central-staff");
await addCp(pipera, "Reception QR", "QR", "pipera-main");

await db.run(`
  INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
  VALUES (?, ?, 'Reception iPad — Central', 'DEMO1234')
`, orgId, central);
await db.run(`
  INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
  VALUES (?, ?, 'Reception iPad — Pipera', 'DEMO5678')
`, orgId, pipera);

// --- staffing requirements (weekdays, plan Phase 5) ------------------------
const addReq = (loc, wd, start, end, role, count) => db.run(`
  INSERT INTO staffing_requirements (organization_id, location_id, weekday, start_time, end_time, job_role_id, required_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`, orgId, loc, wd, start, end, role, count);
for (let wd = 0; wd < 5; wd++) {
  await addReq(central, wd, "08:00", "14:00", roleId["Dentist"], 2);
  await addReq(central, wd, "08:00", "14:00", roleId["Dental Assistant"], 2);
  await addReq(central, wd, "08:00", "20:00", roleId["Receptionist"], 1);
  await addReq(central, wd, "14:00", "20:00", roleId["Dentist"], 1);
  await addReq(pipera, wd, "08:00", "16:00", roleId["Dentist"], 1);
  await addReq(pipera, wd, "08:00", "16:00", roleId["Dental Assistant"], 1);
  await addReq(pipera, wd, "08:00", "16:00", roleId["Receptionist"], 1);
}

// --- shifts: 2 weeks back through 2 weeks ahead, Mon-Fri -------------------
const today = todayStr();
const startMonday = addDays(mondayOf(today), -14);
// Cache user rows — on hosted Postgres every query is a network round trip.
const userCache = new Map();
const userRow = async (id) => {
  if (!userCache.has(id)) userCache.set(id, await db.get("SELECT * FROM users WHERE id = ?", id));
  return userCache.get(id);
};

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
    for (let i = 0; i < everyone.length; i++) {
      if ((i + w) % 6 === d % 6 && d === (i % 5)) continue; // weekly day off
      const u = await userRow(everyone[i]);
      const opts = patterns[u.job_role_id] || [["08:00", "16:00"]];
      const [start, end] = opts[(i + d) % opts.length];
      await db.run(`
        INSERT INTO shifts (organization_id, user_id, date, start_time, end_time, location_id, job_role_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, orgId, everyone[i], date, start, end, u.location_id, u.job_role_id);
    }
  }
}

// --- past attendance with persisted totals ---------------------------------
const jitter = (spread) => Math.floor(Math.random() * spread * 2) - spread;
const shiftTime = (date, time, offsetMin) =>
  new Date(new Date(dateTimeIso(date, time)).getTime() + offsetMin * 60000).toISOString();
const methods = ["WEB", "QR", "KIOSK", "WEB", "QR"];

for (const s of await db.all("SELECT * FROM shifts WHERE date < ?", today)) {
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
  const attId = await insert(`
    INSERT INTO attendance (organization_id, user_id, shift_id, date, clock_in, clock_out,
                            clock_in_method, clock_out_method, location_id, status,
                            worked_minutes, break_minutes, overtime_minutes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
  `, orgId, s.user_id, s.id, s.date, inIso, outIso, method, method,
    s.location_id, worked, brDur, ot, inIso, outIso);
  await db.run("INSERT INTO breaks (attendance_id, start, ended_at) VALUES (?, ?, ?)", attId, brStart, brEnd);
  // Sessions model: some people come back for an evening session (~15% of
  // days whose shift ends by 16:00) — so the Days view shows real in/out pairs.
  if (r > 0.85 && s.end_time <= "16:00") {
    const in2 = shiftTime(s.date, "17:30", jitter(15));
    const out2 = shiftTime(s.date, "19:00", jitter(20));
    const w2 = Math.max(0, minutesBetween(in2, out2));
    await db.run(`
      INSERT INTO attendance (organization_id, user_id, shift_id, date, clock_in, clock_out,
                              clock_in_method, clock_out_method, location_id, status,
                              worked_minutes, break_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'NFC', 'NFC', ?, 'completed', ?, 0, ?, ?)
    `, orgId, s.user_id, s.id, s.date, in2, out2, s.location_id, w2, in2, out2);
  }
  if (overtime > 30) {
    await db.run(`
      INSERT INTO overtime (organization_id, user_id, date, minutes, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `, orgId, s.user_id, s.date, ot, nowIso());
  }
}

// --- today: some clocked in, one on break, one flagged high-risk -----------
const todayShifts = await db.all("SELECT * FROM shifts WHERE date = ?", today);
for (let i = 0; i < todayShifts.length; i++) {
  const s = todayShifts[i];
  if (new Date(dateTimeIso(s.date, s.start_time)) > new Date()) continue;
  if (i % 7 === 3) continue; // late / absent
  const inIso = shiftTime(s.date, s.start_time, jitter(6));
  const risky = i % 9 === 5;
  const attId = await insert(`
    INSERT INTO attendance (organization_id, user_id, shift_id, date, clock_in, clock_in_method,
                            location_id, status, risk_level, risk_signals, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, orgId, s.user_id, s.id, s.date, inIso, risky ? "WEB" : ["WEB", "QR", "KIOSK"][i % 3],
    s.location_id, risky ? "requires_review" : "working",
    risky ? "high" : "low", risky ? JSON.stringify(["location_mismatch:820m", "unknown_device"]) : "[]",
    inIso, inIso);
  if (risky) {
    await db.run(`
      INSERT INTO attendance_flags (organization_id, attendance_id, user_id, kind, detail, risk_level, created_at)
      VALUES (?, ?, ?, 'location_mismatch', '820m from Central Clinic, unknown device', 'high', ?)
    `, orgId, attId, s.user_id, nowIso());
  }
  if (i % 5 === 2) {
    await db.run("INSERT INTO breaks (attendance_id, start) VALUES (?, ?)",
      attId, new Date(Date.now() - 12 * 60000).toISOString());
  }
}

// --- pending requests ------------------------------------------------------
await db.run(`
  INSERT INTO corrections (organization_id, user_id, date, kind, requested_in, requested_out, reason, status, created_at)
  VALUES (?, ?, ?, 'missing_out', '', '16:05', 'I forgot to clock out.', 'pending', ?)
`, orgId, staffIds[3], addDays(today, -1), nowIso());
await db.run(`
  INSERT INTO corrections (organization_id, user_id, date, kind, requested_in, requested_out, reason, status, created_at)
  VALUES (?, ?, ?, 'missing_in', '07:55', '', 'Terminal was busy, went straight to reception.', 'pending', ?)
`, orgId, staffIds[8], addDays(today, -2), nowIso());

const addLeave = (uid, type, s, e, days, note, status) => db.run(`
  INSERT INTO leave_requests (organization_id, user_id, type, start_date, end_date, days, note, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`, orgId, uid, type, s, e, days, note, status, nowIso());
const l1s = addDays(today, 7), l1e = addDays(today, 9);
await addLeave(staffIds[8], "annual", l1s, l1e, businessDays(l1s, l1e), "Family trip", "pending");
const l2s = addDays(today, 3);
await addLeave(staffIds[1], "personal", l2s, l2s, 1, "", "pending");
const l3s = addDays(today, -10), l3e = addDays(today, -8);
await addLeave(staffIds[5], "medical", l3s, l3e, businessDays(l3s, l3e), "Medical certificate attached", "approved");

console.log(`Seeded TapTime (${usingPg ? "PostgreSQL" : "SQLite"}, org: Zâmbet Dental).`);
console.log("Logins (password: taptime123): admin@taptime.app · manager@taptime.app · ana.georgescu@taptime.app");
console.log("Kiosk setup codes: DEMO1234 (Central) · DEMO5678 (Pipera)");
console.log("Checkpoint demo URL: /checkpoint/central-main");

// Close only when run as a script (`npm run seed`); when imported (the Vercel
// SQLite demo path) the server keeps using the same connection.
import { pathToFileURL } from "url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await db.close();
}
