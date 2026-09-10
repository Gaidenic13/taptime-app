// Factory tool: provision a batch of tags before shipping.
//   node server/scripts/make-tags.mjs 10                        → local dev DB
//   DATABASE_URL=... node server/scripts/make-tags.mjs 10       → production
// Write each URL to a physical NFC tag, lock it, box it. That's the whole
// factory step — the customer scans the tag and creates (or extends) their
// clinic right on the scan page. First claim wins; no codes to type.
import crypto from "crypto";

const count = Math.min(200, Math.max(1, parseInt(process.argv[2] || "5", 10)));
const base = process.env.TAPTIME_BASE_URL || "https://taptime-app.vercel.app";

const { db } = await import("../db.js");
const { makeClaimCode } = await import("../domains/org.js");

const urls = [];
for (let i = 0; i < count; i++) {
  const code = crypto.randomBytes(8).toString("hex");
  await db.run(
    "INSERT INTO provisioned_tags (claim_code, code, created_at) VALUES (?, ?, ?)",
    makeClaimCode(), code, new Date().toISOString() // claim_code kept internally, unused
  );
  urls.push(`${base}/checkpoint/${code}`);
}

console.log(`Provisioned ${urls.length} tag(s) — write one URL per tag:\n`);
for (const u of urls) console.log(u);

await db.close();
