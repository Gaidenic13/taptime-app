import { db } from "../db.js";
import { listCredentials } from "./credentials.js";

export async function clinicProfile(actor) {
  const organization = await db.get("SELECT name FROM organizations WHERE id = ?", actor.organization_id);
  return { clinic_name: organization.name, first_name: actor.first_name, last_name: actor.last_name, phone: actor.phone || "" };
}

export async function updateClinicProfile(actor, body) {
  const fields = { clinic_name: 120, first_name: 80, last_name: 80, phone: 40 };
  const profile = {};
  for (const [key, max] of Object.entries(fields)) {
    if (typeof body[key] !== "string" || body[key].trim().length > max) throw new Error(`Invalid ${key}`);
    profile[key] = body[key].trim();
    if (key !== "phone" && !profile[key]) throw new Error(`${key} is required`);
  }
  return db.tx(async (tx) => {
    const before = await tx.get("SELECT name FROM organizations WHERE id = ?", actor.organization_id);
    const now = new Date().toISOString();
    await tx.run("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?", profile.clinic_name, now, actor.organization_id);
    await tx.run("UPDATE users SET first_name = ?, last_name = ?, phone = ? WHERE id = ? AND organization_id = ?", profile.first_name, profile.last_name, profile.phone, actor.id, actor.organization_id);
    await tx.run(`INSERT INTO audit_log (organization_id, actor_id, action, entity_type, entity_id, previous_value, new_value, created_at)
      VALUES (?, ?, 'clinic_profile_update', 'organization', ?, ?, ?, ?)`, actor.organization_id, actor.id, actor.organization_id,
      JSON.stringify({ clinic_name: before.name, first_name: actor.first_name, last_name: actor.last_name, phone: actor.phone }), JSON.stringify(profile), now);
    return { profile };
  });
}

export async function factoryInventory(query = {}) {
  const search = String(query.search || "").trim().toLowerCase().slice(0, 120);
  const status = query.status || "all";
  if (!["all", "activated", "unclaimed"].includes(status)) throw new Error("Invalid inventory status");
  const page = Number(query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid page");
  const where = [], params = [];
  if (status === "activated") where.push("pt.organization_id IS NOT NULL");
  if (status === "unclaimed") where.push("pt.organization_id IS NULL");
  if (search) {
    // Literal substring search: user-entered SQL wildcard characters stay literal.
    const term = `%${search.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    where.push(`(LOWER(pt.code) LIKE ? ESCAPE '!' OR LOWER(o.name) LIKE ? ESCAPE '!'
      OR LOWER(cp.name) LIKE ? ESCAPE '!' OR EXISTS (SELECT 1 FROM users u
        WHERE u.organization_id = pt.organization_id AND u.active = 1 AND u.role IN ('admin', 'owner')
        AND LOWER(u.email) LIKE ? ESCAPE '!'))`);
    params.push(term, term, term, term);
  }
  const from = `FROM provisioned_tags pt LEFT JOIN organizations o ON o.id = pt.organization_id
    LEFT JOIN attendance_checkpoints cp ON cp.code = pt.code`;
  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (await db.get(`SELECT COUNT(*) AS n ${from}${filter}`, ...params)).n;
  const pageSize = 25, pages = Math.max(1, Math.ceil(total / pageSize)), currentPage = Math.min(page, pages);
  const tags = await db.all(`SELECT pt.id, pt.code, pt.created_at, pt.claimed_at, pt.organization_id,
    o.name AS clinic, cp.name AS entrance ${from}${filter} ORDER BY pt.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (currentPage - 1) * pageSize);
  const accounts = new Map();
  for (const tag of tags) {
    if (tag.organization_id && !accounts.has(tag.organization_id)) accounts.set(tag.organization_id, await listCredentials(tag.organization_id));
    tag.accounts = accounts.get(tag.organization_id) || [];
  }
  const counts = await db.get(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN organization_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS activated,
    COALESCE(SUM(CASE WHEN organization_id IS NULL THEN 1 ELSE 0 END), 0) AS unclaimed FROM provisioned_tags`);
  return { tags, total, page: currentPage, pages, counts };
}
