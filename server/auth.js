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

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.run(
    "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
    token, userId, new Date().toISOString()
  );
  return token;
}

export async function destroySession(token) {
  await db.run("DELETE FROM sessions WHERE token = ?", token);
}

// --- known-device tracking (risk signal, plan Phase 8) -----------------------
// The client sends a stable random token in X-Device-Token; we record which
// users have used which device. Absence/newness is a risk signal, not a block.
export async function touchDevice(userId, deviceToken, userAgent = "") {
  if (!deviceToken || deviceToken.length < 16 || deviceToken.length > 128) {
    return { known: false, deviceId: null };
  }
  const now = new Date().toISOString();
  const existing = await db.get(
    "SELECT * FROM devices WHERE token = ? AND user_id = ?", deviceToken, userId
  );
  if (existing) {
    await db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now, existing.id);
    return { known: true, deviceId: existing.id };
  }
  await db.run(
    "INSERT INTO devices (user_id, token, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    userId, deviceToken, String(userAgent).slice(0, 300), now, now
  );
  const created = await db.get(
    "SELECT id FROM devices WHERE token = ? AND user_id = ?", deviceToken, userId
  );
  return { known: false, deviceId: created?.id ?? null };
}

// Async middleware: Express 4 does not catch async errors, so guard explicitly.
const guarded = (fn) => (req, res, next) => {
  fn(req, res, next).catch((e) => res.status(500).json({ error: e.message }));
};

export const requireAuth = guarded(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const user = token
    ? await db.get(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1",
        token
      )
    : null;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  delete user.password_hash;
  req.user = user;
  req.orgId = user.organization_id;
  req.token = token;
  req.deviceToken = req.headers["x-device-token"] || null;
  next();
});

const RANK = { employee: 0, manager: 1, admin: 2, owner: 3 };

export function requireRole(minRole) {
  return (req, res, next) => {
    if ((RANK[req.user.role] ?? -1) >= RANK[minRole]) return next();
    return res.status(403).json({ error: `${minRole} access required` });
  };
}
export const requireManager = requireRole("manager");
export const requireAdmin = requireRole("admin");

// --- PIN brute-force guard (checkpoint tap flow) -----------------------------
// Max 5 failed attempts per source (device token or IP) in a 10-minute window.
export async function assertPinAllowed(source) {
  const windowStart = new Date(Date.now() - 10 * 60000).toISOString();
  const fails = (await db.get(
    "SELECT COUNT(*) AS n FROM pin_attempts WHERE source = ? AND success = 0 AND created_at > ?",
    source, windowStart
  )).n;
  if (fails >= 5) {
    const e = new Error("Too many PIN attempts — try again in a few minutes");
    e.status = 429;
    throw e;
  }
}

export async function recordPinAttempt(source, success) {
  await db.run(
    "INSERT INTO pin_attempts (source, success, created_at) VALUES (?, ?, ?)",
    source, success ? 1 : 0, new Date().toISOString()
  );
}

// --- kiosk restricted sessions (plan Phase 7.3) ------------------------------
export async function registerKiosk(setupCode) {
  const kiosk = await db.get(
    "SELECT * FROM kiosk_devices WHERE setup_code = ? AND status = 'active'",
    String(setupCode || "").trim().toUpperCase()
  );
  if (!kiosk) throw new Error("Setup code not recognized");
  if (kiosk.device_token) throw new Error("This kiosk is already registered — ask an admin to reset it");
  const token = crypto.randomBytes(24).toString("hex");
  await db.run(
    "UPDATE kiosk_devices SET device_token = ?, last_seen_at = ? WHERE id = ?",
    token, new Date().toISOString(), kiosk.id
  );
  return { token, kiosk: { id: kiosk.id, name: kiosk.name, location_id: kiosk.location_id } };
}

export const requireKiosk = guarded(async (req, res, next) => {
  const token = req.headers["x-kiosk-token"] || "";
  const kiosk = token
    ? await db.get("SELECT * FROM kiosk_devices WHERE device_token = ? AND status = 'active'", token)
    : null;
  if (!kiosk) return res.status(401).json({ error: "kiosk_not_registered" });
  await db.run("UPDATE kiosk_devices SET last_seen_at = ? WHERE id = ?", new Date().toISOString(), kiosk.id);
  req.kiosk = kiosk;
  req.orgId = kiosk.organization_id;
  next();
});
