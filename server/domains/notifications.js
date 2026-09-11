import { db } from "../db.js";

// Single write-path for notifications (plan Phase 19). In-app today; when email
// is added it becomes a second transport inside notify(), not a second caller.
export async function notify(orgId, userId, kind, title, body = "", link = "", executor = db) {
  await executor.run(`
    INSERT INTO notifications (organization_id, user_id, kind, title, body, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, orgId, userId, kind, title, body, link, new Date().toISOString());
}

// Notify everyone with manager+ access in the org.
export async function notifyManagers(orgId, kind, title, body = "", link = "") {
  const managers = await db.all(
    "SELECT id FROM users WHERE organization_id = ? AND role IN ('manager','admin','owner') AND active = 1",
    orgId
  );
  for (const m of managers) await notify(orgId, m.id, kind, title, body, link);
}

export async function listNotifications(userId, { unreadOnly = false, limit = 30 } = {}) {
  return db.all(`
    SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""}
    ORDER BY created_at DESC LIMIT ?
  `, userId, limit);
}

export async function unreadCount(userId) {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", userId
  );
  return row.n;
}

export async function markAllRead(userId) {
  await db.run(
    "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
    new Date().toISOString(), userId
  );
}
