import { db } from "../db.js";

// Single write-path for notifications (plan Phase 19). In-app today; when email
// is added it becomes a second transport inside notify(), not a second caller.
export function notify(orgId, userId, kind, title, body = "", link = "") {
  db.prepare(`
    INSERT INTO notifications (organization_id, user_id, kind, title, body, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, userId, kind, title, body, link, new Date().toISOString());
}

// Notify everyone with manager+ access in the org.
export function notifyManagers(orgId, kind, title, body = "", link = "") {
  const managers = db.prepare(
    "SELECT id FROM users WHERE organization_id = ? AND role IN ('manager','admin','owner') AND active = 1"
  ).all(orgId);
  for (const m of managers) notify(orgId, m.id, kind, title, body, link);
}

export function listNotifications(userId, { unreadOnly = false, limit = 30 } = {}) {
  return db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""}
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

export function unreadCount(userId) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL"
  ).get(userId).n;
}

export function markAllRead(userId) {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(
    new Date().toISOString(), userId
  );
}
