import { db } from "./db.js";

// Structured audit trail (plan Phase 18). previous/new values are JSON snapshots
// so history stays traceable without destructive updates elsewhere.
export async function audit({
  orgId = null,
  actorId = null,
  action,
  entityType = "",
  entityId = null,
  previous = null,
  next = null,
  metadata = "",
}, executor = db) {
  await executor.run(`
    INSERT INTO audit_log
      (organization_id, actor_id, action, entity_type, entity_id, previous_value, new_value, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    orgId, actorId, action, entityType, entityId,
    previous == null ? null : JSON.stringify(previous),
    next == null ? null : JSON.stringify(next),
    metadata, new Date().toISOString()
  );
}
