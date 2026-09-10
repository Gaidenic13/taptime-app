import crypto from "crypto";
import { db, insert } from "../db.js";
import { audit } from "../audit.js";
import { createSession, touchDevice } from "../auth.js";

// Identity = the phone, not a shared code. A member has at most ONE trusted
// phone (users.trusted_device_id); only that phone's scans count. Every phone
// link — first phone or a replacement — is a request an admin approves.

const now = () => new Date().toISOString();

async function checkpointFor(tag_code) {
  const cp = await db.get(
    "SELECT * FROM attendance_checkpoints WHERE code = ? AND status = 'active'", String(tag_code || "").trim()
  );
  if (!cp) throw new Error("This tag is not recognized");
  return cp;
}

function requireDevice(device_token) {
  const t = String(device_token || "");
  if (t.length < 16 || t.length > 128) throw new Error("This browser can't be linked — open the tag link in Safari or Chrome");
  return t;
}

async function createLink({ cp, user, device_token, user_agent, kind }) {
  const pending = await db.get(
    "SELECT * FROM phone_links WHERE user_id = ? AND device_token = ? AND status = 'pending'", user.id, device_token
  );
  if (pending) return { link: pending, created: false };
  const token = crypto.randomBytes(24).toString("hex");
  const id = await insert(`
    INSERT INTO phone_links (token, organization_id, user_id, device_token, user_agent, kind, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `, token, cp.organization_id, user.id, device_token, String(user_agent || "").slice(0, 300), kind, now());
  await audit({
    orgId: cp.organization_id, actorId: user.id, action: kind === "join" ? "member_join_request" : "phone_link_request",
    entityType: "user", entityId: user.id, next: { kind, device: device_token.slice(0, 8) },
  });
  const { notifyManagers } = await import("./notifications.js");
  const name = `${user.first_name} ${user.last_name}`.trim();
  await notifyManagers(cp.organization_id, kind === "join" ? "join_request" : "phone_link_request",
    kind === "join" ? `${name} asked to join` : `${name} wants to link a new phone`,
    "Approve or reject it under Approvals", "/approvals");
  return { link: await db.get("SELECT * FROM phone_links WHERE id = ?", id), created: true };
}

// Newcomer: creates a PENDING account by name plus the link request for the
// phone they're holding. Idempotent per name so a double tap doesn't pile up.
export async function joinClinic({ tag_code, first_name, last_name, device_token, user_agent }) {
  const cp = await checkpointFor(tag_code);
  const dev = requireDevice(device_token);
  const first = String(first_name || "").trim(), last = String(last_name || "").trim();
  if (!first) throw new Error("First name is required");

  let user = await db.get(`
    SELECT * FROM users WHERE organization_id = ? AND lower(first_name) = lower(?) AND lower(last_name) = lower(?)
      AND employment_status = 'pending' AND active = 1
  `, cp.organization_id, first, last);
  let created = false;
  if (!user) {
    const id = await insert(`
      INSERT INTO users (organization_id, first_name, last_name, email, pin, role, location_id, employment_status)
      VALUES (?, ?, ?, NULL, '', 'employee', ?, 'pending')
    `, cp.organization_id, first, last, cp.location_id);
    user = await db.get("SELECT * FROM users WHERE id = ?", id);
    created = true;
  }
  const { link } = await createLink({ cp, user, device_token: dev, user_agent, kind: "join" });
  return { user, link, created };
}

// Existing member on a phone that isn't theirs yet: ask by name. Nothing
// typed here can be borrowed — the admin decides whether this phone is theirs.
export async function requestPhoneLink({ tag_code, first_name, last_name, device_token, user_agent }) {
  const cp = await checkpointFor(tag_code);
  const dev = requireDevice(device_token);
  const first = String(first_name || "").trim(), last = String(last_name || "").trim();
  if (!first) throw new Error("First name is required");

  const matches = await db.all(`
    SELECT * FROM users WHERE organization_id = ? AND role = 'employee' AND employment_status = 'active' AND active = 1
      AND lower(first_name) = lower(?) AND (? = '' OR lower(last_name) = lower(?))
  `, cp.organization_id, first, last, last);
  if (matches.length === 0) throw new Error("We couldn't find that name at this clinic — ask the admin how you're registered");
  if (matches.length > 1) throw new Error("More than one person has that name — add your last name");
  const user = matches[0];

  if (user.trusted_device_id) {
    const trusted = await db.get("SELECT token FROM devices WHERE id = ?", user.trusted_device_id);
    if (trusted?.token === dev) throw new Error("This phone is already linked to your account");
  }
  const { link } = await createLink({ cp, user, device_token: dev, user_agent, kind: "link" });
  return { link, user, replaces: !!user.trusted_device_id };
}

// The phone polls this on every scan until it's decided. An approved link is
// exchanged for a member session exactly once — from the requesting phone.
export async function linkStatus(token, device_token) {
  const link = await db.get("SELECT * FROM phone_links WHERE token = ?", String(token || ""));
  if (!link) return { status: "unknown" };
  const user = await db.get("SELECT id, first_name, trusted_device_id FROM users WHERE id = ?", link.user_id);
  const base = { status: link.status, kind: link.kind, first_name: user?.first_name || "" };
  if (link.status !== "approved" || link.exchanged_at) return base;
  if (String(device_token || "") !== link.device_token) return base;
  await db.run("UPDATE phone_links SET exchanged_at = ? WHERE id = ?", now(), link.id);
  return { ...base, session: await createSession(link.user_id) };
}

// Old phone asking why its session died.
export async function phoneReplaced(device_token) {
  if (!device_token) return { replaced: false };
  const row = await db.get(`
    SELECT u.first_name FROM devices d JOIN users u ON u.id = d.user_id
    WHERE d.token = ? AND d.replaced_at IS NOT NULL AND (u.trusted_device_id IS NULL OR u.trusted_device_id != d.id)
    ORDER BY d.replaced_at DESC
  `, String(device_token));
  return row ? { replaced: true, first_name: row.first_name } : { replaced: false };
}

export async function pendingLinks(orgId) {
  return db.all(`
    SELECT pl.id, pl.kind, pl.user_agent, pl.created_at, pl.user_id, u.first_name, u.last_name,
      CASE WHEN u.trusted_device_id IS NULL THEN 0 ELSE 1 END AS replaces
    FROM phone_links pl JOIN users u ON u.id = pl.user_id
    WHERE pl.organization_id = ? AND pl.status = 'pending' ORDER BY pl.created_at
  `, orgId);
}

// Approve: the requesting phone becomes the ONLY trusted phone; every other
// session of that member dies. A 'join' also activates the account.
export async function decidePhoneLink(actor, linkId, decision) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("decision must be approved/rejected");
  const link = await db.get("SELECT * FROM phone_links WHERE id = ?", linkId);
  if (!link || link.organization_id !== actor.organization_id) throw new Error("Request not found");
  if (link.status !== "pending") throw new Error("This request was already decided");
  const user = await db.get("SELECT * FROM users WHERE id = ?", link.user_id);

  if (decision === "approved") {
    const { deviceId } = await touchDevice(user.id, link.device_token, link.user_agent);
    await db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
    await db.run("UPDATE devices SET replaced_at = ? WHERE user_id = ? AND id != ?", now(), user.id, deviceId);
    await db.run(`
      UPDATE users SET trusted_device_id = ?, employment_status = 'active', active = 1,
        manager_id = COALESCE(manager_id, ?) WHERE id = ?
    `, deviceId, actor.id, user.id);
    // Any other pending request for this member is moot now.
    await db.run("UPDATE phone_links SET status = 'rejected', decided_by = ?, decided_at = ? WHERE user_id = ? AND status = 'pending' AND id != ?",
      actor.id, now(), user.id, link.id);
  } else if (link.kind === "join") {
    await db.run("UPDATE users SET employment_status = 'rejected', active = 0 WHERE id = ?", user.id);
  }
  await db.run("UPDATE phone_links SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
    decision, actor.id, now(), link.id);
  await audit({
    orgId: actor.organization_id, actorId: actor.id,
    action: `${link.kind === "join" ? "member" : "phone_link"}_${decision}`,
    entityType: "user", entityId: user.id, next: { link: link.id, replaces: !!user.trusted_device_id },
  });
  return { ok: true };
}

// Admin: lost/stolen phone — nothing scans until a new link is approved.
export async function unlinkPhone(actor, userId) {
  const u = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!u || u.organization_id !== actor.organization_id) throw new Error("Member not found");
  await db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
  await db.run("UPDATE users SET trusted_device_id = NULL WHERE id = ?", u.id);
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "phone_unlinked",
    entityType: "user", entityId: u.id, previous: { trusted_device_id: u.trusted_device_id },
  });
  return { ok: true };
}

// Is this request's session coming from the member's trusted phone?
export async function isTrustedPhone(user, device_token) {
  if (!user.trusted_device_id || !device_token) return false;
  const d = await db.get("SELECT id FROM devices WHERE id = ? AND user_id = ?", user.trusted_device_id, user.id);
  if (!d) return false;
  const row = await db.get("SELECT token FROM devices WHERE id = ?", d.id);
  return row?.token === String(device_token);
}
