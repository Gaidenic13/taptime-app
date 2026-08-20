// Async DB adapter with two drivers (plan: "schema portable, Postgres when SaaS"):
//  - better-sqlite3 when no DATABASE_URL is set (local dev, tests, /tmp demo)
//  - node-postgres when DATABASE_URL / POSTGRES_URL is set (Vercel production)
// All call sites use the same async API: get / all / run / exec / tx.
// SQL is written once in SQLite-flavored syntax ("?" placeholders); the pg
// driver converts placeholders and the DDL dialect.
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dbPath = process.env.TAPTIME_DB || path.join(__dirname, "taptime.db");

const pgUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
export const isPg = !!pgUrl;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'Europe/Bucharest',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Europe/Bucharest',
  latitude REAL,
  longitude REAL,
  attendance_radius_meters INTEGER NOT NULL DEFAULT 150,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS job_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  pin TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'employee',
  job_role_id INTEGER REFERENCES job_roles(id),
  department_id INTEGER REFERENCES departments(id),
  location_id INTEGER REFERENCES locations(id),
  manager_id INTEGER REFERENCES users(id),
  employment_start TEXT DEFAULT '',
  employment_status TEXT NOT NULL DEFAULT 'active',
  leave_balance REAL NOT NULL DEFAULT 21,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS employee_locations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(user_id, token)
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  job_role_id INTEGER REFERENCES job_roles(id),
  status TEXT NOT NULL DEFAULT 'published',
  notes TEXT DEFAULT '',
  UNIQUE(user_id, date, start_time)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  clock_in_method TEXT DEFAULT 'WEB',
  clock_out_method TEXT,
  location_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'working',
  worked_minutes INTEGER,
  break_minutes INTEGER,
  overtime_minutes INTEGER,
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_signals TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id),
  start TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS attendance_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'QR',
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS kiosk_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  setup_code TEXT NOT NULL UNIQUE,
  device_token TEXT UNIQUE,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS attendance_challenges (
  token TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  checkpoint_id INTEGER NOT NULL REFERENCES attendance_checkpoints(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attendance_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  attendance_id INTEGER REFERENCES attendance(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  detail TEXT DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  requested_in TEXT DEFAULT '',
  requested_out TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  decision_note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  decision_note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overtime (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staffing_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  job_role_id INTEGER NOT NULL REFERENCES job_roles(id),
  required_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER REFERENCES organizations(id),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id INTEGER,
  previous_value TEXT,
  new_value TEXT,
  metadata TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_org_date ON attendance(organization_id, date);
CREATE INDEX IF NOT EXISTS idx_shifts_org_date ON shifts(organization_id, date);
CREATE INDEX IF NOT EXISTS idx_flags_open ON attendance_flags(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(organization_id, created_at);
`;

let db;

if (isPg) {
  const { default: pg } = await import("pg");
  // COUNT()/SUM() come back as int8/numeric strings — parse to JS numbers so
  // application code behaves identically to SQLite.
  pg.types.setTypeParser(20, (v) => parseInt(v, 10));      // int8
  pg.types.setTypeParser(1700, (v) => parseFloat(v));       // numeric
  const pool = new pg.Pool({
    connectionString: pgUrl,
    max: Number(process.env.PG_POOL_MAX || 3),
    ssl: pgUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  const convert = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  const on = (client) => ({
    all: async (sql, ...params) => (await client.query(convert(sql), params)).rows,
    get: async (sql, ...params) => (await client.query(convert(sql), params)).rows[0],
    run: async (sql, ...params) => {
      const r = await client.query(convert(sql), params);
      return { changes: r.rowCount };
    },
    exec: async (sql) => { await client.query(sql); },
  });
  db = {
    ...on(pool),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(on(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await db.exec(SCHEMA.replaceAll("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY"));
} else {
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  const wrap = {
    all: async (sql, ...params) => raw.prepare(sql).all(...params),
    get: async (sql, ...params) => raw.prepare(sql).get(...params),
    run: async (sql, ...params) => {
      const r = raw.prepare(sql).run(...params);
      return { changes: r.changes };
    },
    exec: async (sql) => { raw.exec(sql); },
  };
  db = {
    ...wrap,
    // fn runs against the same connection; BEGIN/COMMIT give atomicity.
    tx: async (fn) => {
      raw.exec("BEGIN");
      try {
        const result = await fn(wrap);
        raw.exec("COMMIT");
        return result;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    close: async () => raw.close(),
  };
}

export { db };

// Insert helper: returns the new row id on both drivers (RETURNING id is
// supported by PostgreSQL and by SQLite >= 3.35, which better-sqlite3 bundles).
export async function insert(sql, ...params) {
  const row = await db.get(`${sql} RETURNING id`, ...params);
  return row.id;
}
