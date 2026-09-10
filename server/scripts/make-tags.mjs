// Factory tool: provision a batch of tags before shipping.
//   node server/scripts/make-tags.mjs 10                        → local dev DB
//   DATABASE_URL=... node server/scripts/make-tags.mjs 10       → production
// For each row: write the URL to the physical NFC tag, print the setup code
// on the card that goes in the same box. The customer scans the tag, enters
// the setup code, and the clinic provisions itself.
import crypto from "crypto";

const count = Math.min(200, Math.max(1, parseInt(process.argv[2] || "5", 10)));
const base = process.env.TAPTIME_BASE_URL || "https://taptime-app.vercel.app";

const { db } = await import("../db.js");
const { makeClaimCode } = await import("../domains/org.js");

const rows = [];
for (let i = 0; i < count; i++) {
  const code = crypto.randomBytes(8).toString("hex");
  const claim = makeClaimCode();
  await db.run(
    "INSERT INTO provisioned_tags (claim_code, code, created_at) VALUES (?, ?, ?)",
    claim, code, new Date().toISOString()
  );
  rows.push({ claim, url: `${base}/checkpoint/${code}` });
}

console.log(`Provisioned ${rows.length} tag(s):\n`);
console.log("SETUP CODE  |  WRITE THIS URL TO THE TAG");
for (const r of rows) console.log(`${r.claim}   |  ${r.url}`);
console.log("\nCSV:");
console.log("setup_code,tag_url");
for (const r of rows) console.log(`${r.claim},${r.url}`);

await db.close();
