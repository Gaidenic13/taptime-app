import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dbPath = process.env.TAPTIME_DB || path.join(__dirname, "taptime.db");
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Schema v2 — org-scoped, plan-aligned. Dev data only: changes ship as a fresh
// schema + reseed (see docs/AUDIT.md "Migration approach").
db.exec(`
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
  value TEXT NOT NULL,               -- JSON
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
  role TEXT NOT NULL DEFAULT 'employee',        -- employee | manager | admin | owner
  job_role_id INTEGER REFERENCES job_roles(id),
  department_id INTEGER REFERENCES departments(id),
  location_id INTEGER REFERENCES locations(id),  -- primary location
  manager_id INTEGER REFERENCES users(id),
  employment_start TEXT DEFAULT '',
  employment_status TEXT NOT NULL DEFAULT 'active',
  leave_balance REAL NOT NULL DEFAULT 21,
  active INTEGER NOT NULL DEFAULT 1
);

-- Employees may work at several clinics (plan Phase 3).
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

-- Known devices for risk scoring (plan Phase 8). A device may be shared by
-- several users (front-desk computer), so uniqueness is per user+token.
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
  date TEXT NOT NULL,                            -- YYYY-MM-DD
  start_time TEXT NOT NULL,                      -- HH:MM
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
  clock_in TEXT,                                 -- ISO datetime
  clock_out TEXT,
  clock_in_method TEXT DEFAULT 'WEB',            -- WEB | QR | NFC | KIOSK | MANUAL_APPROVED
  clock_out_method TEXT,
  location_id INTEGER REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'working',        -- working | on_break | completed | requires_review | corrected
  worked_minutes INTEGER,                        -- persisted at clock-out (authoritative)
  break_minutes INTEGER,
  overtime_minutes INTEGER,
  risk_level TEXT NOT NULL DEFAULT 'low',        -- low | medium | high
  risk_signals TEXT DEFAULT '[]',                -- JSON array of signal notes
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id),
  start TEXT NOT NULL,
  end TEXT
);

-- Physical checkpoints: QR poster, NFC tag, kiosk (plan Phase 7).
CREATE TABLE IF NOT EXISTS attendance_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'QR',               -- QR | NFC | KIOSK
  code TEXT NOT NULL UNIQUE,                     -- public identifier in the URL/tag
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS kiosk_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  setup_code TEXT NOT NULL UNIQUE,               -- one-time registration code
  device_token TEXT UNIQUE,                      -- issued at registration
  last_seen_at TEXT
);

-- Server-side short-lived, single-use attendance attempts (plan Phase 8.5).
CREATE TABLE IF NOT EXISTS attendance_challenges (
  token TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  checkpoint_id INTEGER NOT NULL REFERENCES attendance_checkpoints(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by INTEGER REFERENCES users(id)
);

-- Suspicious / review-needed events (plan Phase 8.6-8.7).
CREATE TABLE IF NOT EXISTS attendance_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  attendance_id INTEGER REFERENCES attendance(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                            -- e.g. no_shift, outside_window, unknown_device, location_mismatch, impossible_transition
  detail TEXT DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',           -- open | resolved | dismissed
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

-- Required staffing per weekday/time-band/role (plan Phase 5).
CREATE TABLE IF NOT EXISTS staffing_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  weekday INTEGER NOT NULL,                      -- 0=Mon … 6=Sun
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
  previous_value TEXT,                           -- JSON snapshot
  new_value TEXT,                                -- JSON snapshot
  metadata TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_org_date ON attendance(organization_id, date);
CREATE INDEX IF NOT EXISTS idx_shifts_org_date ON shifts(organization_id, date);
CREATE INDEX IF NOT EXISTS idx_flags_open ON attendance_flags(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(organization_id, created_at);
`);
