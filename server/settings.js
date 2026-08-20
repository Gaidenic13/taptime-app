import { db } from "./db.js";

// Configurable attendance rules (plan Phases 8.3, 8.4, 12). Nothing hard-coded:
// these are per-organization overrides on top of the defaults below.
export const DEFAULT_SETTINGS = {
  clock_in_early_min: 30,      // may clock in up to N min before shift start
  clock_in_late_flag_min: 120, // clocking in later than N min after start flags the event
  late_grace_min: 5,           // minutes after shift start before counted late
  overtime_threshold_min: 30,  // extra minutes beyond schedule that create an overtime record
  require_shift_to_clock_in: false,
  location_mode: "optional",   // required | preferred | optional | disabled
  high_risk_action: "review",  // accept | flag | review  (what to do with HIGH risk events)
  break_max_min: 90,           // breaks longer than this get flagged
};

export function getSettings(orgId) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE organization_id = ?").all(orgId);
  const merged = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { merged[r.key] = JSON.parse(r.value); } catch { /* skip bad rows */ }
  }
  return merged;
}

export function setSetting(orgId, key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
  db.prepare(`
    INSERT INTO settings (organization_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value
  `).run(orgId, key, JSON.stringify(value));
}
