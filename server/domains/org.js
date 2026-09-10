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
export async function claimTag({ tag_code, claim_code, ...signup }) {
  const clean = String(claim_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const tag = await db.get(
    "SELECT * FROM provisioned_tags WHERE code = ?", String(tag_code || "").trim()
  );
  if (!tag) throw new Error("This tag is not recognized");
  if (tag.organization_id) throw new Error("This tag is already linked to a clinic");
  if (clean !== tag.claim_code.replace(/[^A-Z0-9]/g, "")) {
    throw new Error("Setup code doesn't match this tag — check the card in your box");
  }

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

// Unambiguous, human-friendly claim codes (no 0/O/1/I), shown as XXXX-XXXX.
export function makeClaimCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
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
