#!/usr/bin/env node
/**
 * Push content-ideas env vars from .env.local to Vercel production.
 *
 * Prerequisites: `npx vercel login` once.
 *
 * Run: npm run vercel:sync-content-env
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const KEYS = [
  "GEMINI_API_KEY",
  "GRANOLA_SHEET_ID",
  "GRANOLA_SHEET_GID",
  "APP_URL",
  "CRON_SECRET",
  "CONTENT_IDEAS_LLM",
  "GEMINI_MODEL",
];

const envPath = join(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.error("Missing .env.local");
  process.exit(1);
}

const vars = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  vars[key] = val;
}

for (const key of KEYS) {
  const value = vars[key];
  if (!value) {
    console.log(`Skip ${key} (not in .env.local)`);
    continue;
  }

  console.log(`Setting ${key} on production…`);
  const res = spawnSync(
    "npx",
    [
      "vercel",
      "env",
      "add",
      key,
      "production",
      "--value",
      value,
      "--yes",
      "--force",
    ],
    {
      stdio: "inherit",
      cwd: process.cwd(),
    }
  );

  if (res.status !== 0) {
    console.error(`Failed to set ${key}. Run: npx vercel login`);
    process.exit(res.status ?? 1);
  }
}

console.log("\nDone. Redeploy production for vars to take effect:");
console.log("  npx vercel --prod");
