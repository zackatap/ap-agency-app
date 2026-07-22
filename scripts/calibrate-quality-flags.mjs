/**
 * One-off calibration: run Quality + Quantity flags against the latest rollup
 * snapshot and print a distribution summary. Not part of the app runtime.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/calibrate-quality-flags.mjs
 *   or:  npx tsx --env-file=.env.local scripts/calibrate-quality-flags.mjs
 */

import { buildAttentionFeed } from "../src/lib/attention-feed.ts";

function tally(rows, key) {
  const out = { total: 0, byCode: {} };
  for (const r of rows) {
    const code = r[key];
    if (!code || code === "-") continue;
    out.total += 1;
    out.byCode[code] = (out.byCode[code] ?? 0) + 1;
  }
  return out;
}

function printTally(label, t) {
  console.log(`\n${label}: ${t.total} flagged`);
  const entries = Object.entries(t.byCode).sort((a, b) => b[1] - a[1]);
  for (const [code, n] of entries) {
    console.log(`  ${String(n).padStart(3)}  ${code}`);
  }
}

const feed = await buildAttentionFeed({ flaggedMode: "either" });
const rows = feed.rows;
console.log(
  `Snapshot ${feed.snapshotId} finished ${feed.snapshotFinishedAt} · ${rows.length} flagged rows (either)`
);

printTally("Quantity", tally(rows, "attention_code"));
printTally("Quality", tally(rows, "quality_code"));

const both = rows.filter((r) => r.flagged && r.quality_flagged);
const qtyOnly = rows.filter((r) => r.flagged && !r.quality_flagged);
const qlOnly = rows.filter((r) => !r.flagged && r.quality_flagged);
console.log(`\nOverlap: both=${both.length}  quantity-only=${qtyOnly.length}  quality-only=${qlOnly.length}`);

const dataRows = rows.filter((r) => r.quality_code === "Q_DATA");
if (dataRows.length) {
  console.log(`\nQ_DATA samples (up to 8):`);
  for (const r of dataRows.slice(0, 8)) {
    console.log(
      `  ${r.client_name} · appts_30d=${r.crm_leads_30d ?? "?"} (check UI for appts) · ${r.quality_reason}`
    );
  }
}

const qualitySamples = rows
  .filter((r) => r.quality_flagged && r.quality_code !== "Q_DATA")
  .slice(0, 12);
if (qualitySamples.length) {
  console.log(`\nReal Quality samples (up to 12):`);
  for (const r of qualitySamples) {
    console.log(`  [${r.quality_code}] ${r.client_name} — ${r.quality_reason}`);
  }
}
