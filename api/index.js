// Vercel serverless entry: wraps the Express app.
// Vercel's filesystem is read-only except /tmp, and /tmp is ephemeral per
// instance — so this deployment runs as a self-resetting DEMO: the SQLite
// database is seeded into /tmp on every cold start. Real persistence is the
// planned PostgreSQL migration (docs/AUDIT.md).
import fs from "fs";

process.env.TAPTIME_DB = "/tmp/taptime.db";

if (!fs.existsSync(process.env.TAPTIME_DB)) {
  await import("../server/seed.js");
}

const { app } = await import("../server/index.js");
export default app;
