// Attendance checkpoints & challenges (plan Phases 7, 8.5).
// A checkpoint code (QR poster / NFC tag URL) never authorizes attendance by
// itself: reaching it creates a short-lived, single-use, server-side challenge
// that the authenticated employee must consume. Static codes are only triggers.
import crypto from "crypto";
import { db } from "../db.js";
import { audit } from "../audit.js";

export const CHALLENGE_TTL_SEC = 120;

export function checkpointByCode(code) {
  return db.prepare(`
    SELECT c.*, l.name AS location_name FROM attendance_checkpoints c
    JOIN locations l ON l.id = c.location_id
    WHERE c.code = ? AND c.status = 'active'
  `).get(String(code || "").trim());
}

export function createChallenge(checkpoint) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  db.prepare(`
    INSERT INTO attendance_challenges (token, organization_id, checkpoint_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    token, checkpoint.organization_id, checkpoint.id,
    new Date(now).toISOString(), new Date(now + CHALLENGE_TTL_SEC * 1000).toISOString()
  );
  return { token, expires_in: CHALLENGE_TTL_SEC };
}

// Single-use consumption, atomic: the UPDATE only wins if still unconsumed and
// unexpired, which is the replay protection (plan Phase 8.5).
export function consumeChallenge(token, user) {
  const now = new Date().toISOString();
  // Org check is part of the atomic consume: a cross-org attempt must not burn
  // the challenge for the legitimate employee.
  const result = db.prepare(`
    UPDATE attendance_challenges SET consumed_at = ?, consumed_by = ?
    WHERE token = ? AND consumed_at IS NULL AND expires_at > ? AND organization_id = ?
  `).run(now, user.id, token, now, user.organization_id);
  if (result.changes === 0) {
    audit({
      orgId: user.organization_id, actorId: user.id, action: "challenge_rejected",
      entityType: "attendance_challenge", metadata: "expired, replayed, wrong org or unknown",
    });
    return null;
  }
  const ch = db.prepare("SELECT * FROM attendance_challenges WHERE token = ?").get(token);
  return db.prepare("SELECT * FROM attendance_checkpoints WHERE id = ?").get(ch.checkpoint_id);
}

export function createCheckpoint(actor, { location_id, name, type = "QR" }) {
  if (!["QR", "NFC", "KIOSK"].includes(type)) throw new Error("Invalid checkpoint type");
  const loc = db.prepare("SELECT * FROM locations WHERE id = ?").get(location_id);
  if (!loc || loc.organization_id !== actor.organization_id) throw new Error("Location not found");
  const code = crypto.randomBytes(8).toString("hex");
  const info = db.prepare(`
    INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor.organization_id, location_id, name, type, code);
  audit({
    orgId: actor.organization_id, actorId: actor.id, action: "checkpoint_create",
    entityType: "attendance_checkpoint", entityId: info.lastInsertRowid, next: { name, type, location_id },
  });
  return { id: info.lastInsertRowid, code };
}

export function createKiosk(actor, { location_id, name }) {
  const loc = db.prepare("SELECT * FROM locations WHERE id = ?").get(location_id);
  if (!loc || loc.organization_id !== actor.organization_id) throw new Error("Location not found");
  const setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  const info = db.prepare(`
    INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
    VALUES (?, ?, ?, ?)
  `).run(actor.organization_id, location_id, name, setupCode);
  audit({
    orgId: actor.organization_id, actorId: actor.id, action: "kiosk_create",
    entityType: "kiosk_device", entityId: info.lastInsertRowid, next: { name, location_id },
  });
  return { id: info.lastInsertRowid, setup_code: setupCode };
}

export function resetKiosk(actor, kioskId) {
  const kiosk = db.prepare("SELECT * FROM kiosk_devices WHERE id = ?").get(kioskId);
  if (!kiosk || kiosk.organization_id !== actor.organization_id) throw new Error("Kiosk not found");
  const setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  db.prepare("UPDATE kiosk_devices SET device_token = NULL, setup_code = ? WHERE id = ?").run(setupCode, kioskId);
  audit({
    orgId: actor.organization_id, actorId: actor.id, action: "kiosk_reset",
    entityType: "kiosk_device", entityId: kioskId,
  });
  return { setup_code: setupCode };
}
