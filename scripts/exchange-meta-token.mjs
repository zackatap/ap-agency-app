#!/usr/bin/env node
/**
 * Exchange a short-lived Meta User Access Token for a long-lived one (60 days).
 *
 * Run: npm run meta:exchange-token
 *
 * Requires in .env.local:
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_ACCESS_TOKEN  (your current short-lived token)
 *
 * Outputs the long-lived token to paste into META_ACCESS_TOKEN.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Load .env.local from project root (npm runs with cwd = project root)
const envPath = join(process.cwd(), ".env.local");

if (!existsSync(envPath)) {
  console.error("Not found:", envPath);
  process.exit(1);
}

const content = readFileSync(envPath, "utf8");
for (const line of content.split(/\r?\n/)) {
  const trimmed = line.replace(/\r$/, "").trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const shortLivedToken = process.env.META_ACCESS_TOKEN;

if (!appId || !appSecret || !shortLivedToken) {
  console.error("Missing env vars. Need META_APP_ID, META_APP_SECRET, META_ACCESS_TOKEN in .env.local");
  console.error("Save .env.local and try again (unsaved changes won't be read).");
  process.exit(1);
}

const params = new URLSearchParams({
  grant_type: "fb_exchange_token",
  client_id: appId,
  client_secret: appSecret,
  fb_exchange_token: shortLivedToken,
});

const url = `https://graph.facebook.com/v21.0/oauth/access_token?${params}`;

const res = await fetch(url);
const data = await res.json();

if (data.error) {
  console.error("Error:", data.error.message);
  process.exit(1);
}

console.log("\nLong-lived token (expires in ~60 days):\n");
console.log(data.access_token);
console.log("\nCopy this into META_ACCESS_TOKEN in .env.local\n");
