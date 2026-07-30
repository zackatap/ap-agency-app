/**
 * Internal Sales → Google Sheets (AP MASTER - Lead Tracker).
 *
 * Merges:
 *   Leads tab (gid=0) — first-touch UTMs + lead list
 *   Appointments tab (gid=440624040) — booking / show / close outcomes
 *
 * Match order: email (exact, lowercased) → phone (last 10 digits).
 *
 * Env overrides:
 *   INTERNAL_SALES_SHEET_ID
 *   INTERNAL_SALES_SHEET_GID          – appointments gid
 *   INTERNAL_SALES_LEADS_SHEET_GID    – leads gid (default 0)
 *
 * Share the sheet with the service account in GOOGLE_SERVICE_ACCOUNT_JSON
 * (Viewer is enough).
 */

import { google } from "googleapis";

const DEFAULT_SHEET_ID = "1CIFPvwXKj85LDabdjbAtAz6f-ru4UPtkA9CRtH1waR8";
const DEFAULT_APPTS_GID = 440624040;
const DEFAULT_LEADS_GID = 0;
const CACHE_TTL_MS = 60_000;

const TIMEZONE =
  process.env.OPPORTUNITY_TIMEZONE?.trim() || "America/Chicago";

function getSheetId() {
  return process.env.INTERNAL_SALES_SHEET_ID || DEFAULT_SHEET_ID;
}

function getApptsGid() {
  const raw = process.env.INTERNAL_SALES_SHEET_GID;
  if (!raw) return DEFAULT_APPTS_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_APPTS_GID;
}

function getLeadsGid() {
  const raw = process.env.INTERNAL_SALES_LEADS_SHEET_GID;
  if (raw == null || raw === "") return DEFAULT_LEADS_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_LEADS_GID;
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
  return tab?.properties?.title ?? (gid === 0 ? "Leads" : "Appointments");
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
    .replace(/[\s_\-./?'!()[\]{}]+/g, "");
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

export type LeadSourceTab = "leads" | "appointments" | "both";

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
  /**
   * Best-available first-touch / origin date (YYYY-MM-DD).
   * Prefer Leads-tab stamp → Appointment Creation Date → Appt Date.
   */
  leadDate: string | null;
  /** YYYY-MM-DD or null — scheduled appointment day */
  apptDate: string | null;
  /** YYYY-MM-DD or null — when the appointment was booked */
  creationDate: string | null;
  /**
   * Close date proxy (YYYY-MM-DD). Sheet has no closed-on column, so
   * signed rows use apptDate. Null when not signed.
   */
  closeDate: string | null;
  apptStatus: ApptStatusValue;
  apptStatusRaw: string;
  closedStatus: ClosedStatusValue;
  closedStatusRaw: string;
  notes: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  /** Meta campaign ID when present (utm_campaign_id). */
  campaignId: string;
  /** Meta ad set ID when present (utm_term). */
  adSetId: string;
  /** Which sheet tabs contributed to this person. */
  sourceTab: LeadSourceTab;
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
  | "utmcontent"
  | "utmcampaignid"
  | "utmtermadsetid"
  | "utmterm"
  | "ztestdate"
  | "ztestformatted";

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
  utmcampaignid: "utmcampaignid",
  utmtermadsetid: "utmtermadsetid",
  utmterm: "utmterm",
  ztestdate: "ztestdate",
  ztestformatted: "ztestformatted",
};

function cell(row: string[], idx: number | undefined): string {
  if (idx == null || idx < 0) return "";
  return String(row[idx] ?? "").trim();
}

function ymdInTimezone(d: Date): string | null {
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

function todayYmdInTimezone(): string {
  return ymdInTimezone(new Date()) ?? "1970-01-01";
}

/**
 * Parse sheet timestamps like:
 *   "Apr 08, 2025, 04:51 AM (PDT)"
 *   "Feb 03, 2025, 01:30 PM (PST)"
 *   "Friday, July 17, 2026 1:30 PM"
 *   "Friday, 07/17/2026 6:08 AM"
 *   "August 30 at 8:38AM"          (year inferred)
 *   "October 20 at 10:32AM"
 * into YYYY-MM-DD in America/Chicago (or OPPORTUNITY_TIMEZONE).
 */
export function parseSheetDateToYmd(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let cleaned = s
    .replace(
      /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/i,
      ""
    )
    .replace(/\s*\([A-Z]{2,5}\)\s*$/i, "")
    .trim();

  // "August 30 at 8:38AM" / "October 20 at 10:32AM" — no year
  const atMatch = cleaned.match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i
  );
  if (atMatch) {
    const [, monthName, day, hh, mm, ampm] = atMatch;
    const today = todayYmdInTimezone();
    const thisYear = Number(today.slice(0, 4));
    // Try current year first (past or up to ~2 weeks ahead for near bookings),
    // then walk back years for historical rows.
    for (const year of [thisYear, thisYear - 1, thisYear - 2]) {
      const candidate = new Date(
        `${monthName} ${day}, ${year} ${hh}:${mm} ${ampm.toUpperCase()}`
      );
      const ymd = ymdInTimezone(candidate);
      if (!ymd) continue;
      if (ymd <= addDaysYmd(today, 14)) return ymd;
    }
    return null;
  }

  cleaned = cleaned.replace(/(\d{4}),\s+(\d)/, "$1 $2");

  const d = new Date(cleaned);
  return ymdInTimezone(d);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Pull a lead-created stamp from GHL-style notes, e.g.
 *   "Feb 13 2025, 2:42pm (PST)\nCreated by: Jessica"
 */
export function extractLeadDateFromNotes(notes: string): string | null {
  const s = String(notes ?? "");
  if (!s.trim()) return null;

  // Prefer GHL footer stamps: "Feb 13 2025, 2:42pm"
  const stampRe =
    /([A-Za-z]{3,9}\s+\d{1,2}\s+\d{4}),?\s+\d{1,2}:\d{2}\s*(am|pm)/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = stampRe.exec(s))) last = m[1];
  if (last) {
    const ymd = parseSheetDateToYmd(last);
    if (ymd) return ymd;
  }

  // Fallback: first MM/DD/YYYY in the notes
  const slash = s.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (slash) return parseSheetDateToYmd(slash[1]);

  return null;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function emptyOutcome(): Pick<
  InternalSalesLead,
  | "ghlLink"
  | "ownsPractice"
  | "tenure"
  | "revenue"
  | "qualified"
  | "qualifiedRaw"
  | "apptDate"
  | "creationDate"
  | "closeDate"
  | "apptStatus"
  | "apptStatusRaw"
  | "closedStatus"
  | "closedStatusRaw"
> {
  return {
    ghlLink: "",
    ownsPractice: "",
    tenure: "",
    revenue: "",
    qualified: "unknown",
    qualifiedRaw: "",
    apptDate: null,
    creationDate: null,
    closeDate: null,
    apptStatus: "empty",
    apptStatusRaw: "",
    closedStatus: "empty",
    closedStatusRaw: "",
  };
}

function resolveOriginDate(parts: {
  leadStamp: string | null;
  creationDate: string | null;
  apptDate: string | null;
}): string | null {
  return parts.leadStamp || parts.creationDate || parts.apptDate || null;
}

function parseAppointmentRow(
  row: string[],
  cols: Map<HeaderKey, number>
): InternalSalesLead | null {
  const firstName = cell(row, cols.get("firstname"));
  const lastName = cell(row, cols.get("lastname"));
  const phone = cell(row, cols.get("phone"));
  const email = cell(row, cols.get("email"));
  if (!firstName && !lastName && !phone && !email) return null;

  const qualifiedRaw = cell(row, cols.get("qualified"));
  const apptStatusRaw = cell(row, cols.get("apptstatus"));
  const closedStatusRaw = cell(row, cols.get("closedstatus"));
  const apptDate = parseSheetDateToYmd(cell(row, cols.get("apptdate")));
  const creationDate = parseSheetDateToYmd(
    cell(row, cols.get("appointmentcreationdate"))
  );
  const closedStatus = parseClosedStatus(closedStatusRaw);
  const notes = cell(row, cols.get("notes"));
  const leadStamp = extractLeadDateFromNotes(notes);

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
    leadDate: resolveOriginDate({ leadStamp, creationDate, apptDate }),
    apptDate,
    creationDate,
    closeDate: closedStatus === "signed" ? apptDate : null,
    apptStatus: parseApptStatus(apptStatusRaw),
    apptStatusRaw,
    closedStatus,
    closedStatusRaw,
    notes,
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
    campaignId: cell(row, cols.get("utmcampaignid")),
    adSetId:
      cell(row, cols.get("utmtermadsetid")) || cell(row, cols.get("utmterm")),
    sourceTab: "appointments",
  };
}

interface LeadTabRow {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string;
  leadStamp: string | null;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  campaignId: string;
  adSetId: string;
}

function parseLeadTabRow(
  row: string[],
  cols: Map<HeaderKey, number>
): LeadTabRow | null {
  const firstName = cell(row, cols.get("firstname"));
  const lastName = cell(row, cols.get("lastname"));
  const phone = cell(row, cols.get("phone"));
  const email = cell(row, cols.get("email"));
  if (!firstName && !lastName && !phone && !email) return null;

  const notes = cell(row, cols.get("notes"));
  const zDate =
    parseSheetDateToYmd(cell(row, cols.get("ztestdate"))) ||
    parseSheetDateToYmd(cell(row, cols.get("ztestformatted")));

  return {
    firstName,
    lastName,
    phone,
    email,
    notes,
    leadStamp: zDate || extractLeadDateFromNotes(notes),
    utmSource: cell(row, cols.get("utmsource")),
    utmMedium: cell(row, cols.get("utmmedium")),
    utmCampaign: cell(row, cols.get("utmcampaign")),
    utmContent: cell(row, cols.get("utmcontent")),
    campaignId: cell(row, cols.get("utmcampaignid")),
    adSetId: cell(row, cols.get("utmterm")),
  };
}

function prefer(a: string, b: string): string {
  return a.trim() || b.trim();
}

function mergeLeadAndAppt(
  lead: LeadTabRow,
  appt: InternalSalesLead | null
): InternalSalesLead {
  if (!appt) {
    const outcome = emptyOutcome();
    return {
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      email: lead.email,
      ...outcome,
      leadDate: lead.leadStamp,
      notes: lead.notes,
      utmSource: lead.utmSource,
      utmMedium: lead.utmMedium,
      utmCampaign: lead.utmCampaign,
      utmContent: lead.utmContent,
      campaignId: lead.campaignId,
      adSetId: lead.adSetId,
      sourceTab: "leads",
    };
  }

  return {
    firstName: prefer(appt.firstName, lead.firstName),
    lastName: prefer(appt.lastName, lead.lastName),
    phone: prefer(appt.phone, lead.phone),
    email: prefer(appt.email, lead.email),
    ghlLink: appt.ghlLink,
    ownsPractice: appt.ownsPractice,
    tenure: appt.tenure,
    revenue: appt.revenue,
    qualified: appt.qualified,
    qualifiedRaw: appt.qualifiedRaw,
    leadDate: resolveOriginDate({
      leadStamp: lead.leadStamp,
      creationDate: appt.creationDate,
      apptDate: appt.apptDate,
    }),
    apptDate: appt.apptDate,
    creationDate: appt.creationDate,
    closeDate: appt.closeDate,
    apptStatus: appt.apptStatus,
    apptStatusRaw: appt.apptStatusRaw,
    closedStatus: appt.closedStatus,
    closedStatusRaw: appt.closedStatusRaw,
    notes: prefer(appt.notes, lead.notes),
    // First-touch UTMs from Leads when present
    utmSource: prefer(lead.utmSource, appt.utmSource),
    utmMedium: prefer(lead.utmMedium, appt.utmMedium),
    utmCampaign: prefer(lead.utmCampaign, appt.utmCampaign),
    utmContent: prefer(lead.utmContent, appt.utmContent),
    campaignId: prefer(lead.campaignId, appt.campaignId),
    adSetId: prefer(lead.adSetId, appt.adSetId),
    sourceTab: "both",
  };
}

export interface InternalSalesFetchMeta {
  leadTabCount: number;
  appointmentTabCount: number;
  matchedCount: number;
  undatedCount: number;
}

function mergeTabs(
  leadRows: LeadTabRow[],
  apptRows: InternalSalesLead[]
): { leads: InternalSalesLead[]; meta: InternalSalesFetchMeta } {
  const byEmail = new Map<string, InternalSalesLead>();
  const byPhone = new Map<string, InternalSalesLead>();
  const usedAppts = new Set<InternalSalesLead>();

  for (const appt of apptRows) {
    const email = normalizeEmail(appt.email);
    const phone = normalizePhone(appt.phone);
    if (email && !byEmail.has(email)) byEmail.set(email, appt);
    if (phone.length === 10 && !byPhone.has(phone)) byPhone.set(phone, appt);
  }

  const findAppt = (email: string, phone: string): InternalSalesLead | null => {
    const e = normalizeEmail(email);
    if (e && byEmail.has(e)) return byEmail.get(e)!;
    const p = normalizePhone(phone);
    if (p.length === 10 && byPhone.has(p)) return byPhone.get(p)!;
    return null;
  };

  const merged: InternalSalesLead[] = [];
  let matchedCount = 0;
  const seenLeadKeys = new Set<string>();

  for (const lead of leadRows) {
    const email = normalizeEmail(lead.email);
    const phone = normalizePhone(lead.phone);
    const leadKey = email ? `e:${email}` : phone.length === 10 ? `p:${phone}` : "";
    if (leadKey && seenLeadKeys.has(leadKey)) continue;
    if (leadKey) seenLeadKeys.add(leadKey);

    const appt = findAppt(lead.email, lead.phone);
    // First matching lead owns the appointment outcomes.
    if (appt && !usedAppts.has(appt)) {
      matchedCount += 1;
      usedAppts.add(appt);
      merged.push(mergeLeadAndAppt(lead, appt));
    } else if (appt && usedAppts.has(appt)) {
      // Duplicate identity already counted via another lead row.
      continue;
    } else {
      merged.push(mergeLeadAndAppt(lead, null));
    }
  }

  for (const appt of apptRows) {
    if (usedAppts.has(appt)) continue;
    // Re-resolve origin in case notes on the appt row had a stamp
    merged.push({
      ...appt,
      leadDate: resolveOriginDate({
        leadStamp: extractLeadDateFromNotes(appt.notes),
        creationDate: appt.creationDate,
        apptDate: appt.apptDate,
      }),
      sourceTab: "appointments",
    });
  }

  const undatedCount = merged.filter((l) => !l.leadDate).length;

  return {
    leads: merged,
    meta: {
      leadTabCount: leadRows.length,
      appointmentTabCount: apptRows.length,
      matchedCount,
      undatedCount,
    },
  };
}

interface CacheEntry {
  leads: InternalSalesLead[];
  meta: InternalSalesFetchMeta;
  fetchedAt: number;
  error?: string;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

async function fetchSheetRows(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  gid: number
): Promise<string[][]> {
  const title = await getSheetTitleByGid(sheets, spreadsheetId, gid);
  const range = `${quoteSheetRef(title)}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return (res.data.values ?? []) as string[][];
}

async function fetchLeadsUncached(): Promise<CacheEntry> {
  const auth = getAuth();
  if (!auth) {
    return {
      leads: [],
      meta: {
        leadTabCount: 0,
        appointmentTabCount: 0,
        matchedCount: 0,
        undatedCount: 0,
      },
      fetchedAt: Date.now(),
      error: "GOOGLE_SERVICE_ACCOUNT_JSON not configured",
    };
  }

  const spreadsheetId = getSheetId();

  try {
    const sheets = google.sheets({ version: "v4", auth });
    const [leadGrid, apptGrid] = await Promise.all([
      fetchSheetRows(sheets, spreadsheetId, getLeadsGid()),
      fetchSheetRows(sheets, spreadsheetId, getApptsGid()),
    ]);

    const leadCols = buildColumnMap(leadGrid[0] ?? []);
    const apptCols = buildColumnMap(apptGrid[0] ?? []);

    const leadRows: LeadTabRow[] = [];
    for (const row of leadGrid.slice(1)) {
      const parsed = parseLeadTabRow(row, leadCols);
      if (parsed) leadRows.push(parsed);
    }

    const apptRows: InternalSalesLead[] = [];
    for (const row of apptGrid.slice(1)) {
      const parsed = parseAppointmentRow(row, apptCols);
      if (parsed) apptRows.push(parsed);
    }

    const { leads, meta } = mergeTabs(leadRows, apptRows);
    return { leads, meta, fetchedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      leads: [],
      meta: {
        leadTabCount: 0,
        appointmentTabCount: 0,
        matchedCount: 0,
        undatedCount: 0,
      },
      fetchedAt: Date.now(),
      error: msg,
    };
  }
}

/** Fetch merged Leads + Appointments with a 60s in-memory cache. */
export async function fetchInternalSalesLeads(): Promise<{
  leads: InternalSalesLead[];
  meta: InternalSalesFetchMeta;
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
