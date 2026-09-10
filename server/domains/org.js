// Self-serve organization provisioning (distribution/onboarding).
// One signup call gives a new clinic everything it needs to start scanning:
// the organization, its first location, a ready-to-write checkpoint (works as
// both NFC URL and QR), and the admin account — zero configuration required.
import crypto from "crypto";
import { db, insert } from "../db.js";
import { audit } from "../audit.js";
import { hashPassword, createSession } from "../auth.js";

const slugify = (name) =>
  name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "clinic";

export async function createOrganization(
  { clinic_name, first_name, last_name, email, password },
  { checkpointCode = null } = {}
) {
  if (!clinic_name?.trim() || !first_name?.trim() || !last_name?.trim()) {
    throw new Error("Clinic name and your name are required");
  }
  if (!email?.includes("@")) throw new Error("A valid email is required");
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters");
  const cleanEmail = email.trim().toLowerCase();
  if (await db.get("SELECT id FROM users WHERE email = ?", cleanEmail)) {
    throw new Error("That email already has an account");
  }

  const now = new Date().toISOString();
  const slug = `${slugify(clinic_name)}-${crypto.randomBytes(2).toString("hex")}`;
  checkpointCode = checkpointCode || crypto.randomBytes(8).toString("hex");

  const result = await db.tx(async (c) => {
    const org = await c.get(
      "INSERT INTO organizations (name, slug, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
      clinic_name.trim(), slug, now, now
    );
    const loc = await c.get(
      "INSERT INTO locations (organization_id, name) VALUES (?, ?) RETURNING id",
      org.id, clinic_name.trim()
    );
    const cp = await c.get(`
      INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
      VALUES (?, ?, 'Main entrance', 'NFC', ?) RETURNING id, code
    `, org.id, loc.id, checkpointCode);
    const admin = await c.get(`
      INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, location_id, pin)
      VALUES (?, ?, ?, ?, ?, 'admin', ?, ?) RETURNING *
    `, org.id, first_name.trim(), last_name.trim(), cleanEmail, hashPassword(password), loc.id,
      String(1000 + Math.floor(Math.random() * 9000)));
    return { org, loc, cp, admin };
  });

  await audit({
    orgId: result.org.id, actorId: result.admin.id, action: "organization_signup",
    entityType: "organization", entityId: result.org.id, next: { name: clinic_name, slug },
  });

  const token = await createSession(result.admin.id);
  delete result.admin.password_hash;
  return { token, user: result.admin, checkpoint_code: result.cp.code };
}

// ---------------------------------------------------------------- pre-written tags
// The product ships with the tag already written; the box carries a setup code.
// Scanning the fresh tag → claim form → this call: verifies the pair, creates
// the clinic, and binds the tag's code as its checkpoint. The physical tag
// never needs rewriting.
export async function claimTag({ tag_code, claim_code: _ignored, ...signup }) {
  const tag = await verifyUnclaimedTag(tag_code);
  const result = await createOrganization(signup, { checkpointCode: tag.code });
  await db.run(
    "UPDATE provisioned_tags SET organization_id = ?, claimed_at = ? WHERE id = ?",
    result.user.organization_id, new Date().toISOString(), tag.id
  );
  await audit({
    orgId: result.user.organization_id, actorId: result.user.id, action: "tag_claimed",
    entityType: "provisioned_tag", entityId: tag.id, next: { code: tag.code },
  });
  return result;
}

// Shared: the tag must exist and still be unclaimed. First claim wins —
// no setup code, by product decision (boxes go hand-delivered to clinics).
async function verifyUnclaimedTag(tag_code) {
  const tag = await db.get(
    "SELECT * FROM provisioned_tags WHERE code = ?", String(tag_code || "").trim()
  );
  if (!tag) throw new Error("This tag is not recognized");
  if (tag.organization_id) throw new Error("This tag is already linked to a clinic");
  return tag;
}

// Bind a verified tag to an admin's existing clinic as one more checkpoint —
// same team, same Days register, one more door.
async function bindTagToOrg(admin, tag) {
  if (admin.role !== "admin" && admin.role !== "owner") {
    throw new Error("Only a clinic administrator can add tags");
  }
  const count = (await db.get(
    "SELECT COUNT(*) AS n FROM attendance_checkpoints WHERE organization_id = ?", admin.organization_id
  )).n;
  const cp = await db.get(`
    INSERT INTO attendance_checkpoints (organization_id, location_id, name, type, code)
    VALUES (?, ?, ?, 'NFC', ?) RETURNING *
  `, admin.organization_id, admin.location_id, `Entrance ${count + 1}`, tag.code);
  await db.run(
    "UPDATE provisioned_tags SET organization_id = ?, claimed_at = ? WHERE id = ?",
    admin.organization_id, new Date().toISOString(), tag.id
  );
  await audit({
    orgId: admin.organization_id, actorId: admin.id, action: "tag_attached",
    entityType: "attendance_checkpoint", entityId: cp.id, next: { code: tag.code, name: cp.name },
  });
  const org = await db.get("SELECT name FROM organizations WHERE id = ?", admin.organization_id);
  return { checkpoint: { name: cp.name }, clinic: org.name };
}

// A clinic buying ANOTHER TapTime attaches it to the clinic it already has:
// admin credentials (or an existing admin session, see the route) prove
// ownership of the clinic.
export async function attachTag({ tag_code, email, password }) {
  const tag = await verifyUnclaimedTag(tag_code);
  const { verifyPassword } = await import("../auth.js");
  const admin = await db.get(
    "SELECT * FROM users WHERE email = ? AND active = 1", String(email || "").trim().toLowerCase()
  );
  if (!admin || !admin.password_hash || !verifyPassword(password || "", admin.password_hash)) {
    throw new Error("Invalid email or password");
  }
  return bindTagToOrg(admin, tag);
}

// Admin already signed in on the scanning phone: one tap, nothing to type.
export async function attachTagAsAdmin(admin, { tag_code }) {
  const tag = await verifyUnclaimedTag(tag_code);
  return bindTagToOrg(admin, tag);
}

// Unambiguous, human-friendly claim codes (no 0/O/1/I), shown as XXXX-XXXX.
export function makeClaimCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ---------------------------------------------------------------- self-serve join
// Someone scans the clinic's tag and isn't a member yet: they create their own
// account by name. It stays PENDING (scans refused) until an admin approves it
// from the dashboard. Idempotent per name+clinic so double-taps don't pile up.
export async function joinClinic({ tag_code, first_name, last_name, pin: chosen }) {
  const cp = await db.get(
    "SELECT * FROM attendance_checkpoints WHERE code = ? AND status = 'active'", String(tag_code || "").trim()
  );
  if (!cp) throw new Error("This tag is not recognized");
  const first = String(first_name || "").trim(), last = String(last_name || "").trim();
  if (!first) throw new Error("First name is required");

  const existing = await db.get(`
    SELECT * FROM users WHERE organization_id = ? AND lower(first_name) = lower(?) AND lower(last_name) = lower(?)
      AND employment_status = 'pending' AND active = 1
  `, cp.organization_id, first, last);
  if (existing) return { user: existing, created: false };

  // The worker picks their own personal code (their "password" for linking
  // phones); it must be unique within the clinic. Fallback: generated.
  let pin = null;
  if (chosen != null && String(chosen) !== "") {
    const c = String(chosen).trim();
    if (!/^\d{4}$/.test(c)) throw new Error("Your personal code must be exactly 4 digits");
    if (await db.get("SELECT id FROM users WHERE organization_id = ? AND pin = ?", cp.organization_id, c)) {
      throw new Error("That code is already used in this clinic — pick another one");
    }
    pin = c;
  }
  for (let tries = 0; !pin && tries < 50; tries++) {
    const candidate = String(1000 + Math.floor(Math.random() * 9000));
    if (!(await db.get("SELECT id FROM users WHERE organization_id = ? AND pin = ?", cp.organization_id, candidate))) {
      pin = candidate;
    }
  }
  const id = await insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, pin, role, location_id, employment_status)
    VALUES (?, ?, ?, NULL, ?, 'employee', ?, 'pending')
  `, cp.organization_id, first, last, pin, cp.location_id);
  await audit({
    orgId: cp.organization_id, actorId: id, action: "member_join_request",
    entityType: "user", entityId: id, next: { first_name: first, last_name: last },
  });
  const { notifyManagers } = await import("./notifications.js");
  await notifyManagers(cp.organization_id, "join_request",
    `${first} ${last} asked to join`, "Approve them from Team Today", "/team");
  return { user: await db.get("SELECT * FROM users WHERE id = ?", id), created: true };
}

// Admin decision on a self-created account.
export async function setMemberStatus(actor, userId, status) {
  if (!["active", "rejected"].includes(status)) throw new Error("Invalid status");
  const u = await db.get("SELECT * FROM users WHERE id = ?", userId);
  if (!u || u.organization_id !== actor.organization_id) throw new Error("Member not found");
  await db.run(
    "UPDATE users SET employment_status = ?, active = ?, manager_id = COALESCE(manager_id, ?) WHERE id = ?",
    status, status === "active" ? 1 : 0, actor.id, u.id
  );
  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: `member_${status === "active" ? "approved" : "rejected"}`,
    entityType: "user", entityId: u.id, previous: { employment_status: u.employment_status }, next: { employment_status: status },
  });
  return { ok: true };
}

// Quick-add a scan-only member: just a name — no email, no password. A unique
// 4-digit PIN is generated (their whole login is tag + PIN).
export async function quickAddMember(actor, { first_name, last_name }) {
  if (!first_name?.trim()) throw new Error("First name is required");
  let pin;
  for (let tries = 0; tries < 50; tries++) {
    const candidate = String(1000 + Math.floor(Math.random() * 9000));
    if (!(await db.get(
      "SELECT id FROM users WHERE organization_id = ? AND pin = ?", actor.organization_id, candidate
    ))) { pin = candidate; break; }
  }
  if (!pin) throw new Error("Could not generate a free PIN — add one manually");

  const id = await insert(`
    INSERT INTO users (organization_id, first_name, last_name, email, pin, role, location_id, manager_id)
    VALUES (?, ?, ?, NULL, ?, 'employee', ?, ?)
  `, actor.organization_id, first_name.trim(), (last_name || "").trim(), pin, actor.location_id, actor.id);

  await audit({
    orgId: actor.organization_id, actorId: actor.id, action: "employee_quick_add",
    entityType: "user", entityId: id, next: { first_name, last_name },
  });
  return { id, pin };
}
