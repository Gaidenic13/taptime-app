import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildCsv } from "../../src/csv.js";
process.env.NODE_ENV = "test";
process.env.FACTORY_KEY = "test-factory-operations";
const tmp = path.join(os.tmpdir(), `taptime-operations-${process.pid}.db`);
process.env.TAPTIME_DB = tmp;
// This API suite intentionally uses an isolated SQLite database.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const { app } = await import("../index.js");
const { db, insert } = await import("../db.js");
const { createSession } = await import("../auth.js");
const { createShift, copyWeek, validateShift } = await import("../domains/scheduling.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.on("listening", resolve); server.on("error", reject); });
const base = `http://127.0.0.1:${server.address().port}/api`;
let org, other, admin, manager, employee, outsider, location, token, memberToken, managerToken;
async function request(route, { auth = token, method = "GET", body, factory = false } = {}) {
  const res = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(factory ? { "X-Factory-Key": process.env.FACTORY_KEY } : { Authorization: `Bearer ${auth}` }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  const now = new Date().toISOString();
  org = await insert("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('Clinic A', 'a', ?, ?)", now, now);
  other = await insert("INSERT INTO organizations (name, slug, created_at, updated_at) VALUES ('Clinic B', 'b', ?, ?)", now, now);
  location = await insert("INSERT INTO locations (organization_id, name) VALUES (?, 'Central')", org);
  const mk = async (organization_id, role, email) => {
    const id = await insert("INSERT INTO users (organization_id, first_name, last_name, role, email, location_id) VALUES (?, 'Test', 'User', ?, ?, ?)", organization_id, role, email, organization_id === org ? location : null);
    return db.get("SELECT * FROM users WHERE id = ?", id);
  };
  admin = await mk(org, "admin", "admin@a.test");
  manager = await mk(org, "manager", "manager@a.test");
  employee = await mk(org, "employee", null);
  outsider = await mk(other, "admin", "admin@b.test");
  token = await createSession(admin.id); memberToken = await createSession(employee.id); managerToken = await createSession(manager.id);
});
after(async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true }); });

test("clinic profile saves only the signed-in admin and clinic, with access checks and audit", async () => {
  const body = { clinic_name: " Zâmbet Central ", first_name: " Ana ", last_name: " Popescu ", phone: "+40 700 000 000", organization_id: other, id: outsider.id };
  assert.equal((await request("/admin/profile", { auth: "" })).status, 401);
  assert.equal((await request("/admin/profile", { auth: managerToken })).status, 403);
  assert.equal((await request("/admin/profile", { auth: memberToken, method: "PUT", body })).status, 403);
  assert.equal((await request("/admin/profile", { method: "PUT", body: { ...body, clinic_name: " " } })).status, 400);
  const saved = await request("/admin/profile", { method: "PUT", body });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.profile.clinic_name, "Zâmbet Central");
  assert.equal((await request("/admin/profile")).data.profile.first_name, "Ana");
  assert.equal((await db.get("SELECT name FROM organizations WHERE id = ?", other)).name, "Clinic B");
  assert.equal((await db.get("SELECT first_name FROM users WHERE id = ?", outsider.id)).first_name, "Test");
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'clinic_profile_update' AND organization_id = ?", org)).n, 1);
});

test("factory inventory searches all units, filters activation and paginates beyond 100", async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 106; i++) await db.run("INSERT INTO provisioned_tags (code, claim_code, organization_id, created_at, claimed_at) VALUES (?, ?, ?, ?, ?)", `tag-${i}`, `claim-${i}`, i < 3 ? org : null, now, i < 3 ? now : null);
  assert.equal((await request("/factory/tags")).status, 401);
  const first = (await request("/factory/tags", { factory: true })).data;
  assert.equal(first.total, 106); assert.equal(first.pages, 5); assert.equal(first.tags.length, 25);
  assert.deepEqual(first.counts, { total: 106, activated: 3, unclaimed: 103 });
  const last = (await request("/factory/tags?page=5", { factory: true })).data;
  assert.equal(last.tags.length, 6); assert.equal(last.tags.at(-1).code, "tag-0");
  const email = (await request("/factory/tags?search=ADMIN%40A.TEST", { factory: true })).data;
  assert.equal(email.total, 3); assert.equal(email.tags[0].clinic, "Zâmbet Central");
  assert.equal((await request("/factory/tags?search=%25", { factory: true })).data.total, 0);
  assert.equal((await request("/factory/tags?status=unclaimed", { factory: true })).data.total, 103);
  assert.equal((await request("/factory/tags?status=activated&page=99", { factory: true })).data.page, 1);
  assert.equal((await request("/factory/tags?page=-1", { factory: true })).status, 400);
  assert.equal((await request("/factory/tags?status=wrong", { factory: true })).status, 400);
});

test("copy week previews without writes, applies atomically, skips duplicates and keeps clinic isolation", async () => {
  const source = { user_id: employee.id, date: "2030-01-07", start_time: "08:00", end_time: "16:00", location_id: location };
  await createShift(admin, source);
  await createShift(admin, { ...source, date: "2030-01-08" });
  const body = { source_week: "2030-01-07", target_week: "2030-01-14" };
  assert.equal((await request("/schedule/copy-week", { auth: memberToken, method: "POST", body })).status, 403);
  let preview = await copyWeek(admin, body);
  assert.equal(preview.ready, 2); assert.equal(preview.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM shifts WHERE date >= '2030-01-14'")).n, 0);
  const applied = await request("/schedule/copy-week", { auth: managerToken, method: "POST", body: { ...body, apply: true } });
  assert.equal(applied.status, 200); assert.equal(applied.data.created, 2);
  const again = await copyWeek(admin, { ...body, apply: true });
  assert.equal(again.created, 0); assert.equal(again.skipped, 2);
  assert.equal((await copyWeek(outsider, body)).rows.length, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'shift_created' AND user_id = ?", employee.id)).n, 4);
  await assert.rejects(copyWeek(admin, { ...body, target_week: "2030-01-15" }), /Monday/);
  await assert.rejects(copyWeek(admin, { ...body, target_week: body.source_week }), /different/);
  await assert.rejects(validateShift({ userId: employee.id, date: "2030-02-30", startTime: "08:00", endTime: "16:00" }), /Invalid date/);
  await assert.rejects(validateShift({ userId: employee.id, date: "2030-01-01", startTime: "25:00", endTime: "26:00" }), /Invalid time/);
});

test("copy week blocks the entire batch for leave and changed assignments, including after preview", async () => {
  const body = { source_week: "2030-01-07", target_week: "2030-01-21" };
  assert.equal((await copyWeek(admin, body)).ready, 2);
  await db.run("INSERT INTO leave_requests (organization_id, user_id, type, start_date, end_date, days, status, created_at) VALUES (?, ?, 'annual', '2030-01-22', '2030-01-22', 1, 'approved', ?)", org, employee.id, new Date().toISOString());
  const blocked = await copyWeek(admin, { ...body, apply: true });
  assert.equal(blocked.applied, false); assert.equal(blocked.conflicts, 1); assert.equal(blocked.created, 0);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM shifts WHERE date BETWEEN '2030-01-21' AND '2030-01-27'")).n, 0);
  await db.run("UPDATE users SET active = 0 WHERE id = ?", employee.id);
  assert.equal((await copyWeek(admin, body)).conflicts, 2);
  await db.run("UPDATE users SET active = 1 WHERE id = ?", employee.id);
  await createShift(admin, { user_id: employee.id, date: '2030-01-28', start_time: '09:00', end_time: '17:00', location_id: location });
  const overlap = await copyWeek(admin, { ...body, target_week: '2030-01-28', apply: true });
  assert.equal(overlap.conflicts, 1); assert.equal(overlap.created, 0);
  await db.run("UPDATE users SET location_id = NULL WHERE id = ?", employee.id);
  assert.equal((await copyWeek(admin, body)).conflicts, 2);
});

test("CSV handles diacritics, commas, quotes, newlines and formula-like names", () => {
  const csv = buildCsv(["Name", "Hours"], [['Ștefan, "Ana"\nPop', 1.25], ['=SUM(A1)', 2], ['  +cmd', 3], ['@name', -1]]);
  assert.ok(csv.startsWith('\uFEFF"Name","Hours"\r\n'));
  assert.ok(csv.includes('"Ștefan, ""Ana""\nPop","1.25"'));
  assert.ok(csv.includes('"\'=SUM(A1)","2"'));
  assert.ok(csv.includes('"\'  +cmd","3"'));
  assert.ok(csv.includes('"\'@name","-1"'));
});
