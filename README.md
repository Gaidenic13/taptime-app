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
- **Backend:** Express with domain modules (`server/domains/`); scrypt hashing,
  bearer sessions, org-scoped RBAC enforced server-side
- **Database:** dual-driver async adapter ([server/db.js](server/db.js)) —
  SQLite (better-sqlite3) with zero setup for local dev/tests, **PostgreSQL**
  (node-postgres) whenever `DATABASE_URL`/`POSTGRES_URL` is set. Production on
  Vercel runs against Neon Postgres, so data persists.
- **Tests:** `npm test` — node:test suite over the attendance engine, security
  isolation, challenges and scheduling conflicts; runs on SQLite by default or
  against Postgres when `DATABASE_URL` is set

## Run it

```bash
npm install
npm run seed     # wipes & seeds the demo clinic (org: Zâmbet Dental)
npm run dev      # API on :4180 (env API_PORT), app on :4181
npm test         # business-logic test suite
```

The product landing page is available at `/landing/`. It includes the TapTime
3D prototype, hardware details, proposal PDF, and printable model downloads.

**Deployment** (Vercel, auto-deploys on push to `main`): the serverless entry
is [api/index.js](api/index.js). With `DATABASE_URL` set (Neon Postgres via the
Vercel Marketplace) data persists; without it the app falls back to a
self-resetting SQLite demo in `/tmp`. Reseed production with
`DATABASE_URL=... npm run seed` (pull the URL via `npx vercel env pull`).

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

## Clinic administration and operations (September 2026)

- **Settings:** email/password controls remain at the top. Clinic Profile lets an
  admin rename their clinic and update their own name and phone number. Changes
  are scoped to that clinic and recorded in the audit log; tag links stay valid.
- **Factory:** search all inventory by clinic name, admin email, entrance, or tag
  code; filter activated/unclaimed units; view totals and activation dates;
  navigate pages of 25 results. Refresh updates the inventory, and Lock Factory
  clears the locally saved factory key.
- **Schedule → Whole team → Copy week:** choose a Monday, preview shifts using
  the current location/role filters, then create the batch. Overlapping shifts,
  approved leave, inactive staff, or invalid location assignments block the
  whole batch. Exact duplicates are skipped; conflicts are checked again when
  saving. Each created shift has an audit entry and an in-app notification.
- **Reports:** attendance, leave, and staffing CSV downloads use translated
  headers and support Romanian characters, commas, quotes, and line breaks.
  Attendance exports include the previously missing forgotten-clock-out header.

Validation: `npm test` covers attendance, credentials, profile isolation, inventory
pagination/search, schedule-copy conflicts/idempotency, and CSV formatting.
Browser checks use a separate temporary SQLite demo; production data is not seeded
or changed during testing.

## Structure

```
server/
  db.js            schema v2 (org-scoped)      auth.js   sessions, RBAC, kiosk & device auth
  settings.js      configurable rules          audit.js  structured audit trail
  domains/         attendance · scheduling · staffing · requests · checkpoints
                   notifications · reports
  tests/           engine, credentials, and operations tests
  seed.js          demo clinic
src/pages          Login · Terminal (kiosk) · Checkpoint · Dashboard · MyAttendance
                   Schedule · Leave · TeamToday · Approvals · Employees · Reports · Settings
```

## Deferred (next phases)

Passkeys/WebAuthn identity step-up · email/push notification transports ·
automatic recurring schedules · appointment-system integration · payroll-specific exports.

## iOS app (Capacitor)

The same React app ships as a native iOS app (`ios/`, Capacitor 8, Swift Package Manager — no CocoaPods).
What is native: the worker's identity (device token + session) lives in the iOS Keychain
(`ios/App/App/TapTimeNativePlugin.swift`), tags open the app through the `taptime://` URL scheme
(Universal Links once an Apple Team ID is available — see below), an in-app "Scan the clinic tag" button reads
the tag with Core NFC, and check-in/out gives haptic feedback. The web app is unchanged: everything in
`src/native.js` is a no-op in a browser.

**Build for the simulator**

```bash
npm run ios:sync:dev      # web build pointing at http://localhost:4180 (run `npm run dev` for the API), then cap sync
npm run ios:build         # xcodebuild for the iOS Simulator (ad-hoc signed, Keychain works)
```

Or open the project in Xcode: `npm run ios:open`, pick a simulator, Run. For a build against production use
`npm run ios:sync:prod` first. If `xcodebuild` reports "You don't have permission to save…" the repo lives in a
folder macOS protects (e.g. `~/Documents`): build from Xcode once (grant access) or copy `ios/` +
`node_modules/@capacitor` somewhere writable and run `xcodebuild` there with `-derivedDataPath` outside the repo.

**Simulate a tag tap** (the simulator has no NFC; DEBUG builds accept launch arguments):

```bash
xcrun simctl launch booted com.taptime.app -taptime-url "taptime://checkpoint/<tag-code>"
```

`-taptime-js-file <path>` additionally runs a script inside the web view after launch (`-taptime-js-delay`
seconds, default 3) — handy for driving flows headlessly; both flags exist only in DEBUG builds.

**Before a device / App Store build**: set a development team in Xcode (Signing & Capabilities), add the
*Near Field Communication Tag Reading* capability (entitlement `com.apple.developer.nfc.readersession.formats`
= NDEF), and for tag taps that open the app directly add *Associated Domains*
(`applinks:taptime-app.vercel.app`) plus an `apple-app-site-association` file served from
`/.well-known/` with the team's App ID. `NSAllowsLocalNetworking` in `Info.plist` only allows the
`http://localhost` dev API; production talks to `https://taptime-app.vercel.app`.
