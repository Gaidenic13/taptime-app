import crypto from "crypto";
import { db } from "./db.js";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token, userId, new Date().toISOString()
  );
  return token;
}

export function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// --- known-device tracking (risk signal, plan Phase 8) -----------------------
// The client sends a stable random token in X-Device-Token; we record which
// users have used which device. Absence/newness is a risk signal, not a block.
export function touchDevice(userId, deviceToken, userAgent = "") {
  if (!deviceToken || deviceToken.length < 16 || deviceToken.length > 128) return { known: false };
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM devices WHERE token = ? AND user_id = ?").get(deviceToken, userId);
  if (existing) {
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, existing.id);
    return { known: true };
  }
  db.prepare(
    "INSERT INTO devices (user_id, token, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, deviceToken, String(userAgent).slice(0, 300), now, now);
  return { known: false };
}

const userByToken = () =>
  db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`
  );

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const user = token ? userByToken().get(token) : null;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  delete user.password_hash;
  req.user = user;
  req.orgId = user.organization_id;
  req.token = token;
  req.deviceToken = req.headers["x-device-token"] || null;
  next();
}

const RANK = { employee: 0, manager: 1, admin: 2, owner: 3 };

export function requireRole(minRole) {
  return (req, res, next) => {
    if ((RANK[req.user.role] ?? -1) >= RANK[minRole]) return next();
    return res.status(403).json({ error: `${minRole} access required` });
  };
}
export const requireManager = requireRole("manager");
export const requireAdmin = requireRole("admin");

// Organization isolation guard: fetch a row and verify it belongs to the
// caller's org. Returns null (→ treat as not found) on cross-org access.
export function orgRow(req, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  if ("organization_id" in row && row.organization_id !== req.orgId) return null;
  return row;
}

// --- kiosk restricted sessions (plan Phase 7.3) ------------------------------
export function registerKiosk(setupCode) {
  const kiosk = db.prepare(
    "SELECT * FROM kiosk_devices WHERE setup_code = ? AND status = 'active'"
  ).get(String(setupCode || "").trim().toUpperCase());
  if (!kiosk) throw new Error("Setup code not recognized");
  if (kiosk.device_token) throw new Error("This kiosk is already registered — ask an admin to reset it");
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE kiosk_devices SET device_token = ?, last_seen_at = ? WHERE id = ?").run(
    token, new Date().toISOString(), kiosk.id
  );
  return { token, kiosk: { id: kiosk.id, name: kiosk.name, location_id: kiosk.location_id } };
}

export function requireKiosk(req, res, next) {
  const token = req.headers["x-kiosk-token"] || "";
  const kiosk = token
    ? db.prepare("SELECT * FROM kiosk_devices WHERE device_token = ? AND status = 'active'").get(token)
    : null;
  if (!kiosk) return res.status(401).json({ error: "kiosk_not_registered" });
  db.prepare("UPDATE kiosk_devices SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), kiosk.id);
  req.kiosk = kiosk;
  req.orgId = kiosk.organization_id;
  next();
}
