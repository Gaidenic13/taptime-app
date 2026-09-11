import { db } from "../db.js";
import { hashPassword } from "../auth.js";

export const listCredentials = (orgId) => db.all(`
  SELECT id, first_name, last_name, email, role,
    CASE WHEN password_hash <> '' THEN 1 ELSE 0 END AS password_set
  FROM users WHERE organization_id = ? AND active = 1 AND role IN ('admin', 'owner')
  ORDER BY id
`, orgId);

export async function updateCredentials(orgId, userId, body, actorId, keepToken = null) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  if (typeof password !== "string" || (password && (password.length < 6 || password.length > 256))) {
    throw new Error("Password must contain 6–256 characters");
  }
  return db.tx(async (tx) => {
    const user = await tx.get("SELECT * FROM users WHERE id = ? AND organization_id = ? AND active = 1 AND role IN ('admin', 'owner')", userId, orgId);
    if (!user) { const e = new Error("Administrator not found"); e.status = 404; throw e; }
    if (await tx.get("SELECT id FROM users WHERE LOWER(email) = ? AND id <> ?", email, user.id)) {
      throw new Error("This email address is already in use");
    }
    await tx.run("UPDATE users SET email = ?, password_hash = ? WHERE id = ? AND organization_id = ?", email, password ? hashPassword(password) : user.password_hash, user.id, orgId);
    if (password || email !== user.email) {
      await tx.run("DELETE FROM sessions WHERE user_id = ? AND token <> ?", user.id, keepToken || "");
    }
    await tx.run(`INSERT INTO audit_log (organization_id, actor_id, action, entity_type, entity_id, previous_value, new_value, metadata, created_at)
      VALUES (?, ?, 'credentials_update', 'user', ?, ?, ?, ?, ?)`, orgId, actorId, user.id,
      JSON.stringify({ email: user.email }), JSON.stringify({ email, password_changed: !!password }),
      actorId ? "admin settings" : "factory", new Date().toISOString());
    return { account: { id: user.id, first_name: user.first_name, last_name: user.last_name, role: user.role, email, password_set: password || user.password_hash ? 1 : 0 } };
  });
}
