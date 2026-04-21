/**
 * Monthly Pulse → Google Sheets append.
 *
 * The sheet must be shared with the service account email in
 * GOOGLE_SERVICE_ACCOUNT_JSON (Editor access is required to append rows).
 *
 * Env overrides:
 *   PULSE_SHEET_ID       – spreadsheet ID
 *   PULSE_SHEET_GID      – tab/sheet gid (numeric, from URL)
 *
 * Append logic is HEADER-AWARE: we read the first row of the tab and match
 * each value to a column by its header name (normalized, case-insensitive).
 * That means you can reorder columns, rename the tab, or even delete columns
 * you don't want — as long as the header names match one of the supported
 * field keys below, they'll be written. Unknown headers are left untouched.
 *
 * Supported column headers (first match wins, case-insensitive, spaces /
 * hyphens / underscores are ignored, so "Client Name" == "client_name"):
 *
 *   id                  – auto-incremented from max numeric value in column
 *   client_name
 *   location_id
 *   cid
 *   score               – 0–10
 *   sentiment           – "good" | "bad"
 *   wins                – free text (good path)
 *   issues              – comma-separated list (e.g. "Service, Quantity")
 *   issue_quality       – TRUE/FALSE (recommended for filtering)
 *   issue_quantity      – TRUE/FALSE
 *   issue_service       – TRUE/FALSE
 *   issue_roi           – TRUE/FALSE
 *   issue_detail        – free text (bad path)
 *   wants_zoom          – TRUE/FALSE
 *   user_agent
 *   submitted_at
 *   created_at
 */

import { google } from "googleapis";

const DEFAULT_SHEET_ID = "1Za5GR__tGvwzWn2ekqpdNBD5MiU9l4ha-Ylz9o3WM2M";
const DEFAULT_SHEET_GID = 1756325957;

function getSheetId() {
  return process.env.PULSE_SHEET_ID || DEFAULT_SHEET_ID;
}

function getSheetGid() {
  const raw = process.env.PULSE_SHEET_GID;
  if (!raw) return DEFAULT_SHEET_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_SHEET_GID;
}

function getAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  try {
    const credentials = JSON.parse(json);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  } catch {
    return null;
  }
}

async function getSheetTitleByGid(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  gid: number
): Promise<string> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title,sheets.properties.sheetId",
  });
  const tab = meta.data.sheets?.find(
    (s) => (s.properties?.sheetId ?? 0) === gid
  );
  return tab?.properties?.title ?? "Sheet1";
}

function quoteSheetRef(name: string): string {
  return name.includes(" ") || name.includes("'")
    ? `'${name.replace(/'/g, "''")}'`
    : name;
}

function colIndexToLetter(i: number): string {
  let s = "";
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/** Collapse whitespace / punctuation so "Client Name" matches "client_name". */
function normalizeHeader(h: string): string {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[\s_\-./]+/g, "");
}

export interface PulseResponseRecord {
  clientName: string | null;
  locationId: string | null;
  cid: string | null;
  score: number;
  sentiment: "good" | "bad";
  wins: string | null;
  issues: string[];
  issueDetail: string | null;
  wantsZoom: boolean;
  userAgent: string | null;
  submittedAt: string;
}

/** YYYY-MM-DD HH:mm:ss.SSS000+00 to match existing rows. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const ms = pad(d.getUTCMilliseconds(), 3);
  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}000+00`;
}

/** Build the per-field value map for this record. */
function buildFieldValues(record: PulseResponseRecord): Record<string, string | number> {
  const issueSet = new Set(record.issues.map((t) => t.toLowerCase()));
  const has = (tag: string) => issueSet.has(tag.toLowerCase());
  const submittedAt = formatTimestamp(record.submittedAt);
  const createdAt = formatTimestamp(new Date().toISOString());

  return {
    clientname: record.clientName ?? "",
    locationid: record.locationId ?? "",
    cid: record.cid ?? "",
    score: record.score,
    sentiment: record.sentiment,
    wins: record.wins ?? "",
    // Friendly comma-separated list. Easy to read, easy to filter by
    // "Text contains" in Sheets. Empty string when no issues.
    issues: record.issues.length ? record.issues.join(", ") : "",
    issuequality: has("Quality") ? "TRUE" : "FALSE",
    issuequantity: has("Quantity") ? "TRUE" : "FALSE",
    issueservice: has("Service") ? "TRUE" : "FALSE",
    issueroi: has("ROI") ? "TRUE" : "FALSE",
    issuedetail: record.issueDetail ?? "",
    wantszoom: record.wantsZoom ? "TRUE" : "FALSE",
    useragent: record.userAgent ?? "",
    submittedat: submittedAt,
    createdat: createdAt,
  };
}

export type AppendResult =
  | { ok: true; stored: true }
  | { ok: true; stored: false; reason: string }
  | { ok: false; error: string };

export async function appendPulseResponse(
  record: PulseResponseRecord
): Promise<AppendResult> {
  const auth = getAuth();
  if (!auth) {
    return {
      ok: true,
      stored: false,
      reason: "GOOGLE_SERVICE_ACCOUNT_JSON not configured",
    };
  }

  try {
    const spreadsheetId = getSheetId();
    const gid = getSheetGid();
    const sheets = google.sheets({ version: "v4", auth });
    const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
    const sheetRef = quoteSheetRef(title);

    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetRef}!1:1`,
    });
    const headerRow = (headerRes.data.values?.[0] ?? []) as string[];
    if (headerRow.length === 0) {
      return {
        ok: false,
        error:
          "Sheet has no header row — add column headers to row 1 first.",
      };
    }

    const fieldValues = buildFieldValues(record);

    const idColumnIndex = headerRow.findIndex(
      (h) => normalizeHeader(h) === "id"
    );
    let nextId: number | null = null;
    if (idColumnIndex >= 0) {
      const letter = colIndexToLetter(idColumnIndex);
      const idRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetRef}!${letter}2:${letter}`,
        majorDimension: "COLUMNS",
      });
      const col = (idRes.data.values?.[0] ?? []) as string[];
      let max = 0;
      for (const v of col) {
        const n = Number(v);
        if (Number.isFinite(n) && n > max) max = n;
      }
      nextId = max + 1;
    }

    const row: (string | number)[] = headerRow.map((h) => {
      const key = normalizeHeader(h);
      if (key === "id") return nextId ?? "";
      return fieldValues[key] ?? "";
    });

    const lastCol = colIndexToLetter(headerRow.length - 1);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetRef}!A:${lastCol}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [row],
      },
    });

    return { ok: true, stored: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
