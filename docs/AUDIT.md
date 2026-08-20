# Audit — existing app vs. platform plan (2026-08-20)

Mapping of the current codebase against the "Dental Clinic Workforce & Attendance
Platform" plan, plus the decisions taken for the phased implementation.

## What already exists (keep)

| Plan area | Status in current app |
|---|---|
| Web-first responsive app (Ph 0/15) | ✅ React+Vite, mobile tab bar + desktop sidebar |
| Auth + sessions (Ph 2) | ✅ scrypt + bearer sessions; server-side RBAC middleware |
| Employees, locations (Ph 2/3) | ✅ but job roles hard-coded strings, single-location per user |
| Scheduling (Ph 4) | ✅ CRUD + week views; ❌ no conflict validation |
| Clock in/out + breaks (Ph 6/9) | ✅ backend-controlled; ❌ no method/status/risk columns, no transactions |
| Corrections (Ph 10) | ✅ request → approve applies to record + audit |
| Leave (Ph 11) | ✅ balances, working-day calc, approval, overlap warning |
| Overtime (Ph 12) | ✅ auto-detect ≥30 min, approve/reject/compensate |
| Manager dashboard (Ph 13) | ✅ counts + roster + coverage (scheduled vs present); ❌ no required-staffing |
| Approval center (Ph 14) | ✅ leave/corrections/overtime in one screen |
| Kiosk (Ph 7.3) | ✅ PIN terminal; ❌ no kiosk device registration/restricted session |
| Reports (Ph 17) | ✅ monthly attendance register + CSV; ❌ no leave/staffing reports |
| Audit log (Ph 18) | ✅ basic; ❌ no entity/previous/new value structure |

## Gaps to build (this implementation)

1. **Foundation** — `organizations`, configurable `job_roles`, `departments`,
   multi-location assignment, org-scoped records, structured audit log,
   configurable attendance rules (settings), domain-module refactor.
2. **Scheduling validation** — overlapping shifts, invalid times, location conflicts.
3. **Attendance engine hardening** — state machine statuses, clock methods
   (WEB/QR/NFC/KIOSK/MANUAL_APPROVED), persisted worked/break/overtime minutes,
   transactions + idempotency, configurable clock-in window.
4. **Checkpoints** — `attendance_checkpoints` (QR/NFC), server-side short-lived
   single-use challenges, `/checkpoint/:code` web flow, kiosk device registration.
5. **Anti-fraud** — multi-signal risk scoring (shift, window, known device,
   location, checkpoint), duplicate/impossible-event detection, flags +
   requires-review queue, configurable location mode.
6. **Staffing intelligence** — `staffing_requirements` per weekday/role/location,
   Required vs Scheduled vs Present, gap alerts, pending-actions panel.
7. **Notifications** — in-app notifications + bell (email later).
8. **Reports** — leave + staffing reports, filters.
9. **Tests** — attendance engine, authorization isolation, challenges, conflicts.
10. **PWA readiness** — manifest, icons, installability (no offline attendance).

## Technology decisions (deviations from plan, with rationale)

The plan itself instructs: *do not unnecessarily rewrite working functionality;
do not over-engineer the MVP; keep the application deployable throughout.*

- **Stay on Vite+React+Express (not Next.js) for now.** The app is one SPA + one
  API; the domain-module refactor gives the clean boundaries the plan wants.
  A Next.js migration would be a rewrite with no user-facing gain at this stage.
- **PostgreSQL in production, SQLite for dev/tests** *(updated 2026-08-20 —
  the Postgres migration shipped)*: `server/db.js` is a dual-driver async
  adapter — better-sqlite3 with zero setup locally, node-postgres (Neon via
  Vercel Marketplace) whenever `DATABASE_URL` is set. SQL is written once;
  the adapter converts placeholders and the two DDL dialect differences
  (AUTOINCREMENT→SERIAL, int8/numeric parsing).
- **Passkeys/WebAuthn deferred** to the security phase after checkpoints are in;
  the challenge/risk engine is built so a passkey check slots in as one more
  identity signal. Fallbacks (session + kiosk PIN) are in place.
- **Email notifications deferred** (no SMTP available); in-app notifications now,
  the notification writer is a single module so email is an added transport.
- **Timestamps are local-time** (single-timezone org). `organizations.timezone`
  and `locations.timezone` columns exist for the multi-tz migration.

## Migration approach

Demo/dev data only → schema v2 ships as a fresh schema + `npm run seed`
(no in-place migration scripts until there is production data to preserve).
