// Vercel serverless entry: wraps the Express app.
//
// With DATABASE_URL (or POSTGRES_URL) set, the app runs against persistent
// PostgreSQL — seed it once with `DATABASE_URL=... npm run seed`.
//
// Without it, this falls back to a self-resetting SQLite demo: /tmp is
// ephemeral per instance, so the database is reseeded on every cold start.
import fs from "fs";

const hasPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);

if (!hasPg) {
  process.env.TAPTIME_DB = "/tmp/taptime.db";
  if (!fs.existsSync(process.env.TAPTIME_DB)) {
    await import("../server/seed.js");
  }
}

const { app } = await import("../server/index.js");
export default app;
