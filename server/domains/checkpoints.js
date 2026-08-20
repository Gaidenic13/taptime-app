// Attendance checkpoints & challenges (plan Phases 7, 8.5).
// A checkpoint code (QR poster / NFC tag URL) never authorizes attendance by
// itself: reaching it creates a short-lived, single-use, server-side challenge
// that the authenticated employee must consume. Static codes are only triggers.
import crypto from "crypto";
import { db, insert } from "../db.js";
import { audit } from "../audit.js";

export const CHALLENGE_TTL_SEC = 120;

export async function checkpointByCode(code) {
  return db.get(`
    SELECT c.*, l.name AS location_name FROM attendance_checkpoints c
    JOIN locations l ON l.id = c.location_id
    WHERE c.code = ? AND c.status = 'active'
  `, String(code || "").trim());
}

export async function createChallenge(checkpoint) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await db.run(`
    INSERT INTO attendance_challenges (token, organization_id, checkpoint_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `,
    token, checkpoint.organization_id, checkpoint.id,
    new Date(now).toISOString(), new Date(now + CHALLENGE_TTL_SEC * 1000).toISOString()
  );
  return { token, expires_in: CHALLENGE_TTL_SEC };
}

// Single-use consumption, atomic: the UPDATE only wins if still unconsumed,
// unexpired and same-org — which is the replay protection (plan Phase 8.5).
export async function consumeChallenge(token, user) {
  const now = new Date().toISOString();
  const result = await db.run(`
    UPDATE attendance_challenges SET consumed_at = ?, consumed_by = ?
    WHERE token = ? AND consumed_at IS NULL AND expires_at > ? AND organization_id = ?
  `, now, user.id, token, now, user.organization_id);
  if (result.changes === 0) {
    await audit({
      orgId: user.organization_id, actorId: user.id, action: "challenge_rejected",
      entityType: "attendance_challenge", metadata: "expired, replayed, wrong org or unknown",
    });
    return null;
  }
  const ch = await db.get("SELECT * FROM attendance_challenges WHERE token = ?", token);
  return db.get("SELECT * FROM attendance_checkpoints WHERE id = ?", ch.checkpoint_id);
}

export async function createCheckpoint(actor, { location_id, name, type = "QR" }) {
  if (!["QR", "NFC", "KIOSK"].includes(type)) throw new Error("Invalid checkpoint type");
  const loc = await db.get("SELECT * FROM locations WHERE id = ?", location_id);
  if (!loc || loc.organization_id !== actor.organization_id) throw new Error("Location not found");
  const code = crypto.randomBytes(8).toString("hex");
  const id = await insert(`
    INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
    VALUES (?, ?, ?, ?, ?)
  `, actor.organization_id, location_id, name, type, code);
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "checkpoint_create",
    entityType: "attendance_checkpoint", entityId: id, next: { name, type, location_id },
  });
  return { id, code };
}

export async function createKiosk(actor, { location_id, name }) {
  const loc = await db.get("SELECT * FROM locations WHERE id = ?", location_id);
  if (!loc || loc.organization_id !== actor.organization_id) throw new Error("Location not found");
  const setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  const id = await insert(`
    INSERT INTO kiosk_devices (organization_id, location_id, name, setup_code)
    VALUES (?, ?, ?, ?)
  `, actor.organization_id, location_id, name, setupCode);
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "kiosk_create",
    entityType: "kiosk_device", entityId: id, next: { name, location_id },
  });
  return { id, setup_code: setupCode };
}

export async function resetKiosk(actor, kioskId) {
  const kiosk = await db.get("SELECT * FROM kiosk_devices WHERE id = ?", kioskId);
  if (!kiosk || kiosk.organization_id !== actor.organization_id) throw new Error("Kiosk not found");
  const setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  await db.run("UPDATE kiosk_devices SET device_token = NULL, setup_code = ? WHERE id = ?", setupCode, kioskId);
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "kiosk_reset",
    entityType: "kiosk_device", entityId: kioskId,
  });
  return { setup_code: setupCode };
}
