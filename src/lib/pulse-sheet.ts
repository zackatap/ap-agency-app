/**
 * Monthly Pulse → Google Sheets append.
 *
 * The sheet must be shared with the service account email in
 * GOOGLE_SERVICE_ACCOUNT_JSON (Editor access is required to append rows).
 *
 * Defaults target the hard-coded Monthly Pulse sheet; both IDs can be
 * overridden via env vars for staging/testing:
 *   PULSE_SHEET_ID       – spreadsheet ID
 *   PULSE_SHEET_GID      – tab/sheet gid (numeric, from URL)
 *
 * Columns (must match the header row of the sheet tab):
 *   id, client_name, location_id, cid, score, sentiment, wins,
 *   issues, issue_detail, wants_zoom, user_agent, submitted_at, created_at
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
      // Read+write scope — append requires write access.
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
  submittedAt: string; // ISO 8601
}

/**
 * Next integer id based on the highest numeric value in column A (excluding
 * the header row). If column A is empty we start at 1. Best-effort only; if
 * the read fails we return null and skip the id column.
 */
async function nextId(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetRef: string
): Promise<number | null> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetRef}!A2:A`,
      majorDimension: "COLUMNS",
    });
    const col = (res.data.values?.[0] ?? []) as string[];
    let max = 0;
    for (const v of col) {
      const n = Number(v);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return null;
  }
}

/** YYYY-MM-DD HH:mm:ss+00 formatting to match the existing sheet style. */
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

    const id = await nextId(sheets, spreadsheetId, sheetRef);
    const submittedAt = formatTimestamp(record.submittedAt);
    const createdAt = formatTimestamp(new Date().toISOString());

    const row: (string | number)[] = [
      id ?? "",
      record.clientName ?? "",
      record.locationId ?? "",
      record.cid ?? "",
      record.score,
      record.sentiment,
      record.wins ?? "",
      record.issues.length ? JSON.stringify(record.issues) : "[]",
      record.issueDetail ?? "",
      record.wantsZoom ? "TRUE" : "FALSE",
      record.userAgent ?? "",
      submittedAt,
      createdAt,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetRef}!A:M`,
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
