# TapTime — Workforce & Clinic Operations Platform

Web-first attendance ("pontaj") and clinic operations platform for dental
clinics: responsive web app for employees (no app download), desktop dashboards
for managers/admins, kiosk mode for shared tablets, QR/NFC checkpoints at the
door.

**Bilingual (EN/RO)** — every screen has a language toggle (persisted per
device); dates format per locale. **Design**: minimal warm-greige aesthetic —
big typography, soft pills, dashed hairlines, text-only navigation with an
active-dot tab bar on mobile, system font stack, brand violet kept as a quiet
accent. Tokens live in [src/styles.css](src/styles.css); all UI strings in
[src/i18n.jsx](src/i18n.jsx).

Built against the phased plan in `docs/` — see [docs/AUDIT.md](docs/AUDIT.md)
for the plan-vs-implementation mapping and technology decisions.

## Stack

- **Frontend:** React 18 + Vite + react-router — one responsive app (mobile
  tab bar / desktop sidebar), PWA-ready (manifest + installable)
- **Backend:** Express with domain modules (`server/domains/`) + better-sqlite3;
  scrypt hashing, bearer sessions, org-scoped RBAC enforced server-side
- **Tests:** `npm test` — node:test suite over the attendance engine, security
  isolation, challenges and scheduling conflicts on an isolated temp DB

## Run it

```bash
npm install
npm run seed     # wipes & seeds the demo clinic (org: Zâmbet Dental)
npm run dev      # API on :4180 (env API_PORT), app on :4181
npm test         # business-logic test suite
```

## Demo logins (password for all: `taptime123`)

| Email | Role |
|---|---|
| `admin@taptime.app` | Administrator — settings, checkpoints, kiosks, employees |
| `manager@taptime.app` | Head Dentist / Manager — team, approvals, reports |
| `ana.georgescu@taptime.app` | Dental Assistant — employee view |

- **Kiosk mode:** open `/terminal` on the shared tablet, register once with
  setup code `DEMO1234` (Central) or `DEMO5678` (Pipera), then staff use PINs.
- **QR/NFC checkpoint:** `/checkpoint/central-main` — the poster URL opens a
  short-lived single-use challenge; the employee still authenticates.

## Platform capabilities

**Attendance engine** (server-authoritative, transactional)
- Clock in/out/breaks through one engine for all methods: WEB, QR, NFC, KIOSK,
  MANUAL_APPROVED; worked/break/overtime minutes persisted at clock-out
- Configurable rules (Settings → Rules): clock-in window, late grace, overtime
  threshold, break limits, location mode, shift requirement — all audited
- **Anti-fraud risk scoring** on every clock-in: shift validity, time window,
  known device, geolocation vs clinic geofence, checkpoint evidence. HIGH-risk
  events are held for manager review (configurable), MEDIUM are flagged;
  impossible transitions and marathon breaks create flags
- Checkpoint challenges are server-side, short-lived, single-use, org-scoped —
  a photographed QR can never clock anyone in

**Clinic intelligence**
- Staffing requirements per weekday/time-band/role/location (Settings → Staffing)
- Team Today: Required vs Scheduled vs Present with live gap alerts
  ("1 Dental Assistant missing right now at Central Clinic (08:00–14:00)")
- Leave approval shows staffing impact ("only 0/1 receptionists left on Thu")

**Workflow**
- Approval center: leave, corrections (applied with full audit trail, original
  values preserved), overtime (approve/reject/compensate), high-risk reviews,
  open flags — one screen, with pending-actions panel on the manager dashboard
- Scheduling with conflict validation: overlaps, invalid times, location
  assignment, approved-leave collisions; filters by location/role
- In-app notifications (bell): submissions, decisions, shift changes,
  high-risk events; single write-path ready for email transport
- Structured audit log (actor, entity, previous/new values) browsable in Settings

**Organization model** (multi-tenant-ready)
- Organizations → locations (with geofence) → employees; configurable job
  roles & departments; multi-location employee assignment; every table and
  every query org-scoped

## Structure

```
server/
  db.js            schema v2 (org-scoped)      auth.js   sessions, RBAC, kiosk & device auth
  settings.js      configurable rules          audit.js  structured audit trail
  domains/         attendance · scheduling · staffing · requests · checkpoints
                   notifications · reports
  tests/           engine.test.js (11 tests)
  seed.js          demo clinic
src/pages          Login · Terminal (kiosk) · Checkpoint · Dashboard · MyAttendance
                   Schedule · Leave · TeamToday · Approvals · Employees · Reports · Settings
```

## Deferred (next phases)

Passkeys/WebAuthn identity step-up · email/push notification transports ·
PostgreSQL/Prisma migration for SaaS multi-tenancy · recurring schedules ·
appointment-system integration · payroll export · RO translation.
