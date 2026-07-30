/**
 * Internal Sales → Google Sheets (AP MASTER - Lead Tracker → Appointments).
 *
 * Env overrides:
 *   INTERNAL_SALES_SHEET_ID  – spreadsheet ID
 *   INTERNAL_SALES_SHEET_GID – tab gid (numeric)
 *
 * Share the sheet with the service account in GOOGLE_SERVICE_ACCOUNT_JSON
 * (Viewer is enough).
 */

import { google } from "googleapis";

const DEFAULT_SHEET_ID = "1CIFPvwXKj85LDabdjbAtAz6f-ru4UPtkA9CRtH1waR8";
const DEFAULT_SHEET_GID = 440624040;
const CACHE_TTL_MS = 60_000;

const TIMEZONE =
  process.env.OPPORTUNITY_TIMEZONE?.trim() || "America/Chicago";

function getSheetId() {
  return process.env.INTERNAL_SALES_SHEET_ID || DEFAULT_SHEET_ID;
}

function getSheetGid() {
  const raw = process.env.INTERNAL_SALES_SHEET_GID;
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
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
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
  return tab?.properties?.title ?? "Appointments";
}

function quoteSheetRef(name: string): string {
  return name.includes(" ") || name.includes("'")
    ? `'${name.replace(/'/g, "''")}'`
    : name;
}

/** Collapse whitespace / punctuation so headers match flexibly. */
function normalizeHeader(h: string): string {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[\s_\-./?'!]+/g, "");
}

export type QualifiedValue = "yes" | "no" | "unknown";
export type ApptStatusValue =
  | "showed"
  | "no_showed"
  | "cancelled"
  | "rescheduled"
  | "other"
  | "empty";
export type ClosedStatusValue =
  | "signed"
  | "good_chance"
  | "great_chance"
  | "some_chance"
  | "no_chance"
  | "no_show"
  | "other"
  | "empty";

export interface InternalSalesLead {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  ghlLink: string;
  ownsPractice: string;
  tenure: string;
  revenue: string;
  qualified: QualifiedValue;
  qualifiedRaw: string;
  /** YYYY-MM-DD or null */
  apptDate: string | null;
  /** YYYY-MM-DD or null — when the appointment was booked */
  creationDate: string | null;
  apptStatus: ApptStatusValue;
  apptStatusRaw: string;
  closedStatus: ClosedStatusValue;
  closedStatusRaw: string;
  notes: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
}

type HeaderKey =
  | "firstname"
  | "lastname"
  | "phone"
  | "email"
  | "ghllink"
  | "doyouownapractice"
  | "howlonghaveyoubeeninpractice"
  | "whatsyourcurrentmonthlyrevenue"
  | "qualified"
  | "apptdate"
  | "appointmentcreationdate"
  | "apptstatus"
  | "closedstatus"
  | "notes"
  | "utmsource"
  | "adsetutmmedium"
  | "utmmedium"
  | "campaignutmcampaign"
  | "utmcampaign"
  | "adutmcontent"
  | "utmcontent";

const HEADER_ALIASES: Record<string, HeaderKey> = {
  firstname: "firstname",
  lastname: "lastname",
  phone: "phone",
  email: "email",
  ghllink: "ghllink",
  doyouownapractice: "doyouownapractice",
  howlonghaveyoubeeninpractice: "howlonghaveyoubeeninpractice",
  whatsyourcurrentmonthlyrevenue: "whatsyourcurrentmonthlyrevenue",
  qualified: "qualified",
  apptdate: "apptdate",
  appointmentcreationdate: "appointmentcreationdate",
  apptstatus: "apptstatus",
  closedstatus: "closedstatus",
  notes: "notes",
  utmsource: "utmsource",
  adsetutmmedium: "adsetutmmedium",
  utmmedium: "utmmedium",
  campaignutmcampaign: "campaignutmcampaign",
  utmcampaign: "utmcampaign",
  adutmcontent: "adutmcontent",
  utmcontent: "utmcontent",
};

function cell(row: string[], idx: number | undefined): string {
  if (idx == null || idx < 0) return "";
  return String(row[idx] ?? "").trim();
}

/**
 * Parse sheet timestamps like:
 *   "Apr 08, 2025, 04:51 AM (PDT)"
 *   "Feb 03, 2025, 01:30 PM (PST)"
 *   "Friday, July 17, 2026 1:30 PM"
 *   "Friday, 07/17/2026 6:08 AM"
 * into YYYY-MM-DD in America/Chicago (or OPPORTUNITY_TIMEZONE).
 */
export function parseSheetDateToYmd(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let cleaned = s
    // Drop leading weekday
    .replace(
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i,
      ""
    )
    // Drop trailing timezone in parens
    .replace(/\s*\([A-Z]{2,5}\)\s*$/i, "")
    .trim();

  // Normalize "Jul 17, 2026 1:30 PM" / "07/17/2026 6:08 AM"
  // Remove extra comma between date and time if present: "Apr 08, 2025, 04:51 AM"
  cleaned = cleaned.replace(/(\d{4}),\s+(\d)/, "$1 $2");

  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  if (!y || !m || !day) return null;
  return `${y}-${m}-${day}`;
}

function parseQualified(raw: string): QualifiedValue {
  const v = raw.trim().toLowerCase().replace(/!+$/, "");
  if (v === "yes") return "yes";
  if (v === "no") return "no";
  return "unknown";
}

function parseApptStatus(raw: string): ApptStatusValue {
  const v = raw.trim().toLowerCase();
  if (!v || v === "status") return "empty";
  if (v === "showed") return "showed";
  if (v === "no showed" || v === "noshowed" || v === "no-show" || v === "no show")
    return "no_showed";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  if (v === "rescheduled") return "rescheduled";
  return "other";
}

function parseClosedStatus(raw: string): ClosedStatusValue {
  const v = raw.trim().toLowerCase();
  if (!v) return "empty";
  if (v === "signed") return "signed";
  if (v === "good chance") return "good_chance";
  if (v === "great chance") return "great_chance";
  if (v === "some chance") return "some_chance";
  if (v === "no chance") return "no_chance";
  if (v === "no show" || v === "noshow" || v === "no-show") return "no_show";
  return "other";
}

function buildColumnMap(headers: string[]): Map<HeaderKey, number> {
  const map = new Map<HeaderKey, number>();
  headers.forEach((h, i) => {
    const key = HEADER_ALIASES[normalizeHeader(h)];
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}

function parseRow(row: string[], cols: Map<HeaderKey, number>): InternalSalesLead | null {
  const firstName = cell(row, cols.get("firstname"));
  const lastName = cell(row, cols.get("lastname"));
  const phone = cell(row, cols.get("phone"));
  const email = cell(row, cols.get("email"));
  if (!firstName && !lastName && !phone && !email) return null;

  const qualifiedRaw = cell(row, cols.get("qualified"));
  const apptStatusRaw = cell(row, cols.get("apptstatus"));
  const closedStatusRaw = cell(row, cols.get("closedstatus"));

  return {
    firstName,
    lastName,
    phone,
    email,
    ghlLink: cell(row, cols.get("ghllink")),
    ownsPractice: cell(row, cols.get("doyouownapractice")),
    tenure: cell(row, cols.get("howlonghaveyoubeeninpractice")),
    revenue: cell(row, cols.get("whatsyourcurrentmonthlyrevenue")),
    qualified: parseQualified(qualifiedRaw),
    qualifiedRaw,
    apptDate: parseSheetDateToYmd(cell(row, cols.get("apptdate"))),
    creationDate: parseSheetDateToYmd(
      cell(row, cols.get("appointmentcreationdate"))
    ),
    apptStatus: parseApptStatus(apptStatusRaw),
    apptStatusRaw,
    closedStatus: parseClosedStatus(closedStatusRaw),
    closedStatusRaw,
    notes: cell(row, cols.get("notes")),
    utmSource: cell(row, cols.get("utmsource")),
    utmMedium:
      cell(row, cols.get("adsetutmmedium")) ||
      cell(row, cols.get("utmmedium")),
    utmCampaign:
      cell(row, cols.get("campaignutmcampaign")) ||
      cell(row, cols.get("utmcampaign")),
    utmContent:
      cell(row, cols.get("adutmcontent")) ||
      cell(row, cols.get("utmcontent")),
  };
}

interface CacheEntry {
  leads: InternalSalesLead[];
  fetchedAt: number;
  error?: string;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

async function fetchLeadsUncached(): Promise<CacheEntry> {
  const auth = getAuth();
  if (!auth) {
    return {
      leads: [],
      fetchedAt: Date.now(),
      error: "GOOGLE_SERVICE_ACCOUNT_JSON not configured",
    };
  }

  const spreadsheetId = getSheetId();
  const gid = getSheetGid();

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
    const range = `${quoteSheetRef(title)}!A:X`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const rows = (res.data.values ?? []) as string[][];
    if (rows.length < 2) {
      return { leads: [], fetchedAt: Date.now() };
    }
    const cols = buildColumnMap(rows[0] ?? []);
    const leads: InternalSalesLead[] = [];
    for (const row of rows.slice(1)) {
      const lead = parseRow(row, cols);
      if (lead) leads.push(lead);
    }
    return { leads, fetchedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { leads: [], fetchedAt: Date.now(), error: msg };
  }
}

/** Fetch Appointments rows with a 60s in-memory cache. */
export async function fetchInternalSalesLeads(): Promise<{
  leads: InternalSalesLead[];
  fetchedAt: number;
  error?: string;
  fromCache: boolean;
}> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache, fromCache: true };
  }

  if (!inflight) {
    inflight = fetchLeadsUncached().finally(() => {
      inflight = null;
    });
  }

  const entry = await inflight;
  cache = entry;
  return { ...entry, fromCache: false };
}

/** Test helper — clear cache between tests. */
export function clearInternalSalesSheetCache() {
  cache = null;
}
