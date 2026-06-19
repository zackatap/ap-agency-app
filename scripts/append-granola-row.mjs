#!/usr/bin/env node
/**
 * Append content ideas (from Granola meeting analysis) to a Google Sheet.
 *
 * Run:
 *   npm run granola:append -- '{"title":"...","source":"Weekly Huddle (Jun 2)","hooks":["...","...","..."]}'
 *   npm run granola:append -- --file ./ideas.json
 *
 * Pass a JSON array to append multiple rows (e.g. 5 ideas at once):
 *   npm run granola:append -- --file ./ideas-batch.json
 *
 * Requires in .env.local:
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *   GRANOLA_SHEET_ID
 *   GRANOLA_SHEET_GID
 *
 * Sheet headers: #, Title, Type, Source, Status, Hooks
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { google } from "googleapis";

const envPath = join(process.cwd(), ".env.local");

function loadEnvLocal() {
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
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
}

function normalizeHeader(h) {
  const raw = String(h ?? "").trim().toLowerCase();
  if (raw === "#") return "id";
  return raw.replace(/[\s_\-./]+/g, "");
}

function colIndexToLetter(i) {
  let s = "";
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

function quoteSheetRef(name) {
  return name.includes(" ") || name.includes("'")
    ? `'${name.replace(/'/g, "''")}'`
    : name;
}

function parseInput(argv) {
  const fileIdx = argv.indexOf("--file");
  let parsed;
  if (fileIdx >= 0) {
    const filePath = argv[fileIdx + 1];
    if (!filePath) {
      console.error("Missing path after --file");
      process.exit(1);
    }
    const abs = join(process.cwd(), filePath);
    if (!existsSync(abs)) {
      console.error("File not found:", abs);
      process.exit(1);
    }
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } else {
    const jsonArg = argv.find((a) => a.startsWith("{") || a.startsWith("["));
    if (!jsonArg) {
      console.error(
        'Pass JSON inline or use --file ideas.json\nExample: npm run granola:append -- \'{"title":"Raw Video Beats Cinematic","source":"Weekly Huddle (Jun 2)","hooks":["Hook 1","Hook 2","Hook 3"]}\''
      );
      process.exit(1);
    }
    parsed = JSON.parse(jsonArg);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Format hooks as numbered list matching existing sheet rows. */
function formatHooks(hooks) {
  if (typeof hooks === "string") return hooks;
  if (!Array.isArray(hooks)) return "";
  return hooks
    .filter(Boolean)
    .map((h, i) => `${i + 1}. ${String(h).replace(/^\d+\.\s*/, "")}`)
    .join("\n");
}

function buildFieldValues(record) {
  return {
    title: record.title ?? "",
    type: record.type ?? "One-time",
    source: record.source ?? "",
    status: record.status ?? "Saved",
    hooks: formatHooks(record.hooks),
  };
}

async function getSheetTitleByGid(sheets, spreadsheetId, gid) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title,sheets.properties.sheetId",
  });
  const tab = meta.data.sheets?.find((s) => (s.properties?.sheetId ?? 0) === gid);
  return tab?.properties?.title ?? "Sheet1";
}

async function getNextId(sheets, spreadsheetId, sheetRef, headerRow) {
  const idColumnIndex = headerRow.findIndex((h) => normalizeHeader(h) === "id");
  if (idColumnIndex < 0) return null;

  const letter = colIndexToLetter(idColumnIndex);
  const idRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetRef}!${letter}2:${letter}`,
    majorDimension: "COLUMNS",
  });
  const col = idRes.data.values?.[0] ?? [];
  let max = 0;
  for (const v of col) {
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function buildRow(headerRow, fieldValues, id) {
  return headerRow.map((h) => {
    const key = normalizeHeader(h);
    if (key === "id") return id ?? "";
    return fieldValues[key] ?? "";
  });
}

async function appendRows(records) {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = process.env.GRANOLA_SHEET_ID;
  const gid = Number(process.env.GRANOLA_SHEET_GID);

  if (!json) {
    console.error("Missing GOOGLE_SERVICE_ACCOUNT_JSON in .env.local");
    process.exit(1);
  }
  if (!spreadsheetId) {
    console.error("Missing GRANOLA_SHEET_ID in .env.local");
    process.exit(1);
  }
  if (!Number.isFinite(gid)) {
    console.error("Missing or invalid GRANOLA_SHEET_GID in .env.local");
    process.exit(1);
  }

  const credentials = JSON.parse(json);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
  const sheetRef = quoteSheetRef(title);

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetRef}!1:1`,
  });
  const headerRow = headerRes.data.values?.[0] ?? [];
  if (headerRow.length === 0) {
    console.error("Sheet has no header row. Add column headers to row 1 first.");
    process.exit(1);
  }

  let nextId = await getNextId(sheets, spreadsheetId, sheetRef, headerRow);
  const rows = records.map((record) => {
    const fieldValues = buildFieldValues(record);
    const row = buildRow(headerRow, fieldValues, nextId);
    if (nextId != null) nextId += 1;
    return row;
  });

  const lastCol = colIndexToLetter(headerRow.length - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetRef}!A:${lastCol}`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  console.log(`Appended ${rows.length} row(s) to "${title}"`);
}

loadEnvLocal();
const records = parseInput(process.argv.slice(2));
await appendRows(records);
