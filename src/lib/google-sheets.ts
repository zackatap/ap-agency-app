/**
 * Google Sheets API integration for looking up Ad Account ID and Campaign Keyword.
 * Uses a service account - the sheet must be shared with the service account email.
 *
 * Env: GOOGLE_SERVICE_ACCOUNT_JSON - full JSON key as string
 */

import { google } from "googleapis";

const SHEET_ID = "1EoTMWobj0uBag81ahTUrIfi6fBKY0L32h6PdUHMqixw";
/** Tab/sheet gid from the URL - use this to target the correct tab. Env: FACEBOOK_SHEET_GID */
const SHEET_GID = Number(process.env.FACEBOOK_SHEET_GID ?? 1722936157);

function getAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  try {
    const credentials = JSON.parse(json);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
  } catch {
    return null;
  }
}

/**
 * Get the sheet (tab) title by its gid (sheetId from the URL).
 */
async function getSheetTitleByGid(sheets: ReturnType<typeof google.sheets>): Promise<string> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties.title,sheets.properties.sheetId",
  });
  const targetId = Number(SHEET_GID);
  const tab = meta.data.sheets?.find((s) => (s.properties?.sheetId ?? 0) === targetId);
  return tab?.properties?.title ?? "Sheet1";
}

/**
 * Fetch all rows from the first sheet.
 * Uses explicit A:AO range to ensure column AO (GHL Location ID) is included -
 * the default "whole sheet" range can trim columns and omit AO.
 */
export async function fetchSheetRows(): Promise<{ rows: string[][]; error?: string }> {
  const auth = getAuth();
  if (!auth) {
    return { rows: [], error: "GOOGLE_SERVICE_ACCOUNT_JSON not configured" };
  }

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const sheetName = await getSheetTitleByGid(sheets);
    const sheetRef = sheetName.includes(" ") || sheetName.includes("'") ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
    // Explicit A:AO range ensures we get column AO (GHL Location ID)
    const range = `${sheetRef}!A:AO`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });
    const rows = (res.data.values ?? []) as string[][];
    return { rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], error: msg };
  }
}

export interface LocationFacebookConfig {
  adAccountId: string;
  campaignKeywords: string[];
}

/** Column letter to 0-based index: G=6, J=9, AO=40 */
const COL_G = 6;
const COL_J = 9;
const COL_AO = 40;

export interface SheetLookupDebug {
  searchedFor: string;
  sheetRowCount: number;
  matchedRowCount: number;
  /** All non-empty values from the location ID column for comparison */
  allLocationIdsFromSheet: string[];
  /** First row (headers) – use to verify column layout */
  headerRow: string[];
  /** 0-based index of column used for location ID */
  locationIdColumnIndex: number;
  /** Column letter (e.g. AO) for location ID */
  locationIdColumnLetter: string;
  reason?: string;
}

/** Find column index by header text (case-insensitive, substring match) */
function findColumnIndex(headerRow: string[], ...patterns: string[]): number {
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] ?? "").toLowerCase();
    for (const p of patterns) {
      if (h.includes(p.toLowerCase())) return i;
    }
  }
  return -1;
}

function colIndexToLetter(i: number): string {
  let s = "";
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/**
 * Look up Ad Account ID and Campaign Keyword options for a location.
 * Sheet structure: Row 1 = headers. Columns detected by header:
 *   - "GHL LOCATION ID" / "LOCATION ID" → location ID
 *   - "Ad Account" / "ad account" → Ad Account ID
 *   - "Campaign" / "keyword" → campaign keyword
 * Falls back to G, J, AO if headers not found.
 */
export async function getLocationFacebookConfig(
  locationId: string
): Promise<{
  config: LocationFacebookConfig | null;
  error?: string;
  debug?: SheetLookupDebug;
}> {
  const { rows, error } = await fetchSheetRows();
  const locMatch = String(locationId).trim();

  const headerRow = (rows[0] ?? []).map((c) => String(c ?? ""));
  const dataRows = rows.slice(1);

  // Detect columns by header; fallback to G, J, AO
  let colLocationId = findColumnIndex(headerRow, "ghl location id", "location id", "locationid");
  if (colLocationId < 0) colLocationId = COL_AO;
  let colAdAccount = findColumnIndex(headerRow, "ad account", "ad account id");
  if (colAdAccount < 0) colAdAccount = COL_G;
  let colCampaign = findColumnIndex(headerRow, "campaign", "keyword");
  if (colCampaign < 0) colCampaign = COL_J;

  const allLocationIds = dataRows.map((r) => String(r[colLocationId] ?? "").trim()).filter(Boolean);

  const makeDebug = (reason: string, matched: number, total: number): SheetLookupDebug => ({
    searchedFor: locMatch,
    sheetRowCount: total,
    matchedRowCount: matched,
    allLocationIdsFromSheet: allLocationIds,
    headerRow,
    locationIdColumnIndex: colLocationId,
    locationIdColumnLetter: colIndexToLetter(colLocationId),
    reason,
  });

  // Diagnostic logging
  console.log("[sheet-lookup] Header row length:", headerRow.length);
  console.log("[sheet-lookup] Location ID column:", colLocationId, "(" + colIndexToLetter(colLocationId) + ")");
  console.log("[sheet-lookup] First 3 rows - column count:", dataRows.slice(0, 3).map((r) => r.length));
  if (dataRows.length > 0 && dataRows[0].length > colLocationId) {
    console.log("[sheet-lookup] First data row, locationId cell:", JSON.stringify(dataRows[0][colLocationId]));
  }
  console.log("[sheet-lookup] IDs from column", colIndexToLetter(colLocationId) + ":", allLocationIds.length);

  if (error) return { config: null, error, debug: makeDebug(error, 0, 0) };
  if (rows.length < 2) return { config: null, debug: makeDebug("Sheet has no data rows", 0, rows.length) };

  const matchingRows = dataRows.filter((row) => {
    const rowLoc = String(row[colLocationId] ?? "").trim();
    return rowLoc === locMatch;
  });

  if (matchingRows.length === 0) {
    const debug = makeDebug(
      `No rows in column ${colIndexToLetter(colLocationId)} match "${locMatch}"`,
      0,
      dataRows.length
    );
    console.log("[sheet-lookup] No match. Searched:", locMatch);
    console.log("[sheet-lookup] All IDs:\n", allLocationIds.join("\n"));
    return { config: null, debug };
  }

  // Ad Account ID
  let adAccountId = "";
  for (const row of matchingRows) {
    const val = String(row[colAdAccount] ?? "").trim();
    if (val) {
      adAccountId = val.startsWith("act_") ? val : `act_${val}`;
      break;
    }
  }

  if (!adAccountId) {
    return {
      config: null,
      debug: makeDebug(
        `Matched ${matchingRows.length} row(s) but Ad Account column was empty`,
        matchingRows.length,
        dataRows.length
      ),
    };
  }

  // Campaign keywords
  const keywordsSet = new Set<string>();
  for (const row of matchingRows) {
    const val = String(row[colCampaign] ?? "").trim();
    if (val) keywordsSet.add(val);
  }
  const campaignKeywords = [...keywordsSet].sort();

  return {
    config: { adAccountId, campaignKeywords },
    debug: {
      searchedFor: locMatch,
      sheetRowCount: dataRows.length,
      matchedRowCount: matchingRows.length,
      allLocationIdsFromSheet: allLocationIds,
      headerRow,
      locationIdColumnIndex: colLocationId,
      locationIdColumnLetter: colIndexToLetter(colLocationId),
      reason: "OK",
    },
  };
}
