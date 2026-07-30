/**
 * Internal Sales metric calculations from merged Leads + Appointments rows.
 *
 * Rates:
 *   Booking = booked / leads
 *   Show    = showed / (showed + no_showed)  — cancel/reschedule excluded
 *   Close   = signed / showed
 *   Qualified = yes / (yes + no)
 *
 * Counting modes:
 *   activity — count each stage on the date it happened
 *              lead → leadDate, booked → creationDate, show/cancel → apptDate,
 *              signed → closeDate (apptDate proxy)
 *   cohort   — include people whose leadDate is in range; count ALL eventual
 *              outcomes (ad attribution: "Jan leads → N closes")
 */

import type { DateRange } from "@/lib/date-ranges";
import { getMonthsBack, getPreviousPeriod } from "@/lib/date-ranges";
import type { InternalSalesLead } from "@/lib/internal-sales-sheet";

export type CountingMode = "activity" | "cohort";

export interface InternalSalesCounts {
  leads: number;
  booked: number;
  showed: number;
  noShowed: number;
  cancelled: number;
  rescheduled: number;
  signed: number;
  pipeline: number;
  noChance: number;
  qualifiedYes: number;
  qualifiedNo: number;
  qualifiedUnknown: number;
}

export interface InternalSalesRates {
  bookingRate: number | null;
  showRate: number | null;
  closeRate: number | null;
  qualifiedRate: number | null;
}

export interface InternalSalesMetrics {
  counts: InternalSalesCounts;
  rates: InternalSalesRates;
}

export interface InternalSalesMonthRow {
  monthKey: string;
  label: string;
  startDate: string;
  endDate: string;
  metrics: InternalSalesMetrics;
}

/**
 * Multi-select attribution filters. Empty / missing array = no filter.
 * Special value __blank__ matches empty cells.
 */
export interface AttributionFilters {
  campaigns?: string[];
  adSets?: string[];
  ads?: string[];
  sources?: string[];
}

export type AttributionDimension = "campaign" | "adSet" | "ad" | "source";

export interface AttributionBreakdownRow {
  key: string;
  label: string;
  metrics: InternalSalesMetrics;
}

export interface AttributionFilterOptions {
  campaigns: string[];
  adSets: string[];
  ads: string[];
  sources: string[];
}

export const BLANK_ATTR = "__blank__";

export const COUNTING_MODE_LABELS: Record<CountingMode, string> = {
  activity: "When it happened",
  cohort: "Lead cohort",
};

export const COUNTING_MODE_HELP: Record<CountingMode, string> = {
  activity:
    "Leads, bookings, shows, and closes each count on the date that stage happened.",
  cohort:
    "People who became leads in this range. Bookings / shows / closes count whenever they happened later.",
};

function attrValue(raw: string): string {
  return raw.trim();
}

function attrKey(raw: string): string {
  const v = attrValue(raw);
  return v || BLANK_ATTR;
}

function matchesAttrToken(raw: string, filter: string): boolean {
  if (filter === BLANK_ATTR) return !attrValue(raw);
  return attrValue(raw) === filter;
}

/** True if any candidate field matches any selected token (OR within dimension). */
function matchesAnyAttr(
  candidates: string[],
  selected: string[] | undefined
): boolean {
  if (!selected?.length) return true;
  return selected.some((token) =>
    candidates.some((c) => matchesAttrToken(c, token))
  );
}

export function hasAttributionFilters(filters: AttributionFilters): boolean {
  return !!(
    filters.campaigns?.length ||
    filters.adSets?.length ||
    filters.ads?.length ||
    filters.sources?.length
  );
}

/** Min/max origin / stage dates across leads (YYYY-MM-DD), if any. */
export function getLeadDateSpan(
  leads: InternalSalesLead[]
): { min: string; max: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const lead of leads) {
    for (const d of [
      lead.leadDate,
      lead.apptDate,
      lead.creationDate,
      lead.closeDate,
    ]) {
      if (!d) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
  }
  return min && max ? { min, max } : null;
}

function isMetaObjectId(value: string): boolean {
  return /^\d{8,}$/.test(value.trim());
}

/**
 * Build name ↔ id synonym sets from sheet rows so filtering by campaign name
 * also matches rows that only stored the Meta campaign id (and vice versa).
 */
export function buildCampaignAliasMap(
  leads: InternalSalesLead[]
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const aa = attrValue(a);
    const bb = attrValue(b);
    if (!aa || !bb || aa === bb) return;
    if (!map.has(aa)) map.set(aa, new Set([aa]));
    if (!map.has(bb)) map.set(bb, new Set([bb]));
    const merged = new Set([...map.get(aa)!, ...map.get(bb)!]);
    for (const key of merged) map.set(key, merged);
  };

  for (const lead of leads) {
    const name = attrValue(lead.utmCampaign);
    const id = attrValue(lead.campaignId);
    if (name && id && !isMetaObjectId(name)) link(name, id);
    if (name && isMetaObjectId(name) && id && name !== id) link(name, id);
  }
  return map;
}

export function expandFilterTokens(
  tokens: string[] | undefined,
  aliasMap: Map<string, Set<string>>
): string[] | undefined {
  if (!tokens?.length) return tokens;
  const out = new Set<string>();
  for (const token of tokens) {
    out.add(token);
    const syns = aliasMap.get(token);
    if (syns) for (const s of syns) out.add(s);
  }
  return [...out];
}

export function filterLeadsByAttribution(
  leads: InternalSalesLead[],
  filters: AttributionFilters
): InternalSalesLead[] {
  const aliasMap = buildCampaignAliasMap(leads);
  const campaigns = expandFilterTokens(filters.campaigns, aliasMap);
  const adSets = filters.adSets;
  const ads = filters.ads;
  const sources = filters.sources;

  return leads.filter(
    (l) =>
      matchesAnyAttr([l.utmCampaign, l.campaignId], campaigns) &&
      matchesAnyAttr([l.utmMedium, l.adSetId], adSets) &&
      matchesAnyAttr([l.utmContent], ads) &&
      matchesAnyAttr([l.utmSource], sources)
  );
}

function uniqueSorted(values: string[]): string[] {
  const set = new Set<string>();
  let hasBlank = false;
  for (const v of values) {
    const t = attrValue(v);
    if (!t) hasBlank = true;
    else set.add(t);
  }
  const list = [...set].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  if (hasBlank) list.push(BLANK_ATTR);
  return list;
}

/**
 * Prefer human campaign names in the dropdown. Bare Meta IDs are remapped to
 * their known name when the sheet has both.
 */
function displayCampaignOptions(leads: InternalSalesLead[]): string[] {
  const aliasMap = buildCampaignAliasMap(leads);
  const idToName = new Map<string, string>();
  for (const [key, syns] of aliasMap) {
    if (!isMetaObjectId(key)) continue;
    for (const s of syns) {
      if (!isMetaObjectId(s)) {
        idToName.set(key, s);
        break;
      }
    }
  }

  const labels = new Set<string>();
  let hasBlank = false;
  for (const lead of leads) {
    const raw = attrValue(lead.utmCampaign);
    if (!raw) {
      hasBlank = true;
      continue;
    }
    if (isMetaObjectId(raw)) {
      labels.add(idToName.get(raw) || raw);
    } else {
      labels.add(raw);
    }
  }
  const list = [...labels].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  if (hasBlank) list.push(BLANK_ATTR);
  return list;
}

/** Dropdown options. When a parent filter is set, child lists narrow to matching rows. */
export function listAttributionOptions(
  leads: InternalSalesLead[],
  filters: AttributionFilters = {}
): AttributionFilterOptions {
  const forAdSets = filters.campaigns?.length
    ? filterLeadsByAttribution(leads, { campaigns: filters.campaigns })
    : leads;
  const forAds = filterLeadsByAttribution(leads, {
    campaigns: filters.campaigns,
    adSets: filters.adSets,
  });

  return {
    campaigns: displayCampaignOptions(leads),
    adSets: uniqueSorted(forAdSets.map((l) => l.utmMedium)),
    ads: uniqueSorted(forAds.map((l) => l.utmContent)),
    sources: uniqueSorted(leads.map((l) => l.utmSource)),
  };
}

function dimensionRaw(
  lead: InternalSalesLead,
  dimension: AttributionDimension
): string {
  switch (dimension) {
    case "campaign":
      return lead.utmCampaign;
    case "adSet":
      return lead.utmMedium;
    case "ad":
      return lead.utmContent;
    case "source":
      return lead.utmSource;
  }
}

/**
 * Group leads in range by an attribution dimension.
 * Sorted by signed desc, then leads desc.
 */
export function computeAttributionBreakdown(
  leads: InternalSalesLead[],
  range: DateRange,
  dimension: AttributionDimension,
  mode: CountingMode = "cohort"
): AttributionBreakdownRow[] {
  const groups = new Map<string, InternalSalesLead[]>();
  for (const lead of leads) {
    if (!personTouchesRange(lead, range, mode)) continue;
    const key = attrKey(dimensionRaw(lead, dimension));
    const list = groups.get(key);
    if (list) list.push(lead);
    else groups.set(key, [lead]);
  }

  const rows: AttributionBreakdownRow[] = [];
  for (const [key, group] of groups) {
    rows.push({
      key,
      label: key === BLANK_ATTR ? "(none)" : key,
      metrics: computeInternalSalesMetrics(group, range, mode),
    });
  }

  rows.sort((a, b) => {
    const signedDiff = b.metrics.counts.signed - a.metrics.counts.signed;
    if (signedDiff !== 0) return signedDiff;
    const showDiff = b.metrics.counts.showed - a.metrics.counts.showed;
    if (showDiff !== 0) return showDiff;
    return b.metrics.counts.leads - a.metrics.counts.leads;
  });

  return rows;
}

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.round((num / den) * 1000) / 10; // one decimal
}

function inRange(ymd: string, range: DateRange): boolean {
  return ymd >= range.startDate && ymd <= range.endDate;
}

function isBooked(lead: InternalSalesLead): boolean {
  return !!(lead.apptDate || lead.creationDate);
}

/** Book date: when the appointment was created, else appt day. */
function bookDate(lead: InternalSalesLead): string | null {
  return lead.creationDate || lead.apptDate;
}

function emptyCounts(): InternalSalesCounts {
  return {
    leads: 0,
    booked: 0,
    showed: 0,
    noShowed: 0,
    cancelled: 0,
    rescheduled: 0,
    signed: 0,
    pipeline: 0,
    noChance: 0,
    qualifiedYes: 0,
    qualifiedNo: 0,
    qualifiedUnknown: 0,
  };
}

export function ratesFromCounts(counts: InternalSalesCounts): InternalSalesRates {
  return {
    bookingRate: pct(counts.booked, counts.leads),
    showRate: pct(counts.showed, counts.showed + counts.noShowed),
    closeRate: pct(counts.signed, counts.showed),
    qualifiedRate: pct(
      counts.qualifiedYes,
      counts.qualifiedYes + counts.qualifiedNo
    ),
  };
}

function tallyOutcomes(
  lead: InternalSalesLead,
  counts: InternalSalesCounts,
  opts: { qualify: boolean; showClose: boolean }
) {
  if (opts.qualify) {
    if (lead.qualified === "yes") counts.qualifiedYes += 1;
    else if (lead.qualified === "no") counts.qualifiedNo += 1;
    else counts.qualifiedUnknown += 1;
  }

  if (!opts.showClose) return;

  switch (lead.apptStatus) {
    case "showed":
      counts.showed += 1;
      break;
    case "no_showed":
      counts.noShowed += 1;
      break;
    case "cancelled":
      counts.cancelled += 1;
      break;
    case "rescheduled":
      counts.rescheduled += 1;
      break;
    default:
      break;
  }

  switch (lead.closedStatus) {
    case "signed":
      counts.signed += 1;
      break;
    case "good_chance":
    case "great_chance":
    case "some_chance":
      counts.pipeline += 1;
      break;
    case "no_chance":
      counts.noChance += 1;
      break;
    default:
      break;
  }
}

/** Whether this person should appear in breakdowns for the range/mode. */
export function personTouchesRange(
  lead: InternalSalesLead,
  range: DateRange,
  mode: CountingMode
): boolean {
  if (mode === "cohort") {
    return !!(lead.leadDate && inRange(lead.leadDate, range));
  }
  if (lead.leadDate && inRange(lead.leadDate, range)) return true;
  const bookedOn = bookDate(lead);
  if (bookedOn && inRange(bookedOn, range)) return true;
  if (lead.apptDate && inRange(lead.apptDate, range)) return true;
  if (lead.closeDate && inRange(lead.closeDate, range)) return true;
  return false;
}

/** Slim row for the dashboard detail table. */
export interface InternalSalesLeadRow {
  name: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  ghlLink: string;
  leadDate: string | null;
  creationDate: string | null;
  apptDate: string | null;
  closeDate: string | null;
  qualified: string;
  apptStatus: string;
  closedStatus: string;
  campaign: string;
  adSet: string;
  ad: string;
  source: string;
  campaignId: string;
  notes: string;
  sourceTab: string;
}

function displayStatus(raw: string, fallback: string): string {
  const r = raw.trim();
  if (r) return r;
  if (!fallback || fallback === "empty" || fallback === "unknown") return "";
  return fallback.replace(/_/g, " ");
}

export function toLeadTableRow(lead: InternalSalesLead): InternalSalesLeadRow {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  return {
    name: name || "(no name)",
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    email: lead.email,
    ghlLink: lead.ghlLink,
    leadDate: lead.leadDate,
    creationDate: lead.creationDate,
    apptDate: lead.apptDate,
    closeDate: lead.closeDate,
    qualified: displayStatus(lead.qualifiedRaw, lead.qualified),
    apptStatus: displayStatus(lead.apptStatusRaw, lead.apptStatus),
    closedStatus: displayStatus(lead.closedStatusRaw, lead.closedStatus),
    campaign: lead.utmCampaign,
    adSet: lead.utmMedium,
    ad: lead.utmContent,
    source: lead.utmSource,
    campaignId: lead.campaignId,
    notes: lead.notes.length > 400 ? `${lead.notes.slice(0, 400)}…` : lead.notes,
    sourceTab: lead.sourceTab,
  };
}

/**
 * People in the current date range + counting mode, newest lead/appt first.
 */
export function filterLeadsInRange(
  leads: InternalSalesLead[],
  range: DateRange,
  mode: CountingMode
): InternalSalesLead[] {
  return leads
    .filter((lead) => personTouchesRange(lead, range, mode))
    .sort((a, b) => {
      const ad = a.apptDate || a.creationDate || a.leadDate || "";
      const bd = b.apptDate || b.creationDate || b.leadDate || "";
      if (ad === bd) {
        return `${a.lastName}${a.firstName}`.localeCompare(
          `${b.lastName}${b.firstName}`
        );
      }
      return ad < bd ? 1 : -1;
    });
}

export function buildLeadTableRows(
  leads: InternalSalesLead[],
  range: DateRange,
  mode: CountingMode
): InternalSalesLeadRow[] {
  return filterLeadsInRange(leads, range, mode).map(toLeadTableRow);
}

/**
 * Activity: each stage counts on its own date.
 * Cohort: people with leadDate in range; all eventual outcomes counted.
 */
export function computeInternalSalesMetrics(
  leads: InternalSalesLead[],
  range: DateRange,
  mode: CountingMode = "activity"
): InternalSalesMetrics {
  const counts = emptyCounts();

  if (mode === "cohort") {
    for (const lead of leads) {
      if (!lead.leadDate || !inRange(lead.leadDate, range)) continue;
      counts.leads += 1;
      if (isBooked(lead)) counts.booked += 1;
      tallyOutcomes(lead, counts, { qualify: true, showClose: true });
    }
    return { counts, rates: ratesFromCounts(counts) };
  }

  // Activity mode
  for (const lead of leads) {
    const becameLead = !!(lead.leadDate && inRange(lead.leadDate, range));
    const bookedOn = bookDate(lead);
    const becameBooked = !!(bookedOn && inRange(bookedOn, range));
    const apptInRange = !!(lead.apptDate && inRange(lead.apptDate, range));
    const closedInRange = !!(lead.closeDate && inRange(lead.closeDate, range));

    if (becameLead) counts.leads += 1;
    if (becameBooked) counts.booked += 1;

    // Qualify with the lead-origin window when we have one; else with booking
    if (becameLead || (!lead.leadDate && becameBooked)) {
      if (lead.qualified === "yes") counts.qualifiedYes += 1;
      else if (lead.qualified === "no") counts.qualifiedNo += 1;
      else if (becameLead || becameBooked) counts.qualifiedUnknown += 1;
    }

    if (apptInRange) {
      switch (lead.apptStatus) {
        case "showed":
          counts.showed += 1;
          break;
        case "no_showed":
          counts.noShowed += 1;
          break;
        case "cancelled":
          counts.cancelled += 1;
          break;
        case "rescheduled":
          counts.rescheduled += 1;
          break;
        default:
          break;
      }

      // Pipeline / no-chance tracked on appt day (status snapshot)
      switch (lead.closedStatus) {
        case "good_chance":
        case "great_chance":
        case "some_chance":
          counts.pipeline += 1;
          break;
        case "no_chance":
          counts.noChance += 1;
          break;
        default:
          break;
      }
    }

    if (closedInRange && lead.closedStatus === "signed") {
      counts.signed += 1;
    }
  }

  return { counts, rates: ratesFromCounts(counts) };
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTH_LABELS[(m ?? 1) - 1] ?? monthKey} ${y}`;
}

/**
 * Month-to-month using the active counting mode.
 * Returns most recent first (matches client conversions Month to Month).
 */
export function computeMonthlyMetrics(
  leads: InternalSalesLead[],
  months = 13,
  todayOverride?: string,
  mode: CountingMode = "activity"
): InternalSalesMonthRow[] {
  const ranges = getMonthsBack(months, todayOverride);
  return ranges.map((r) => {
    const metrics = computeInternalSalesMetrics(leads, r, mode);
    return {
      monthKey: r.monthKey,
      label: monthLabel(r.monthKey),
      startDate: r.startDate,
      endDate: r.endDate,
      metrics,
    };
  });
}

export function computeWithCompare(
  leads: InternalSalesLead[],
  range: DateRange,
  mode: CountingMode = "activity"
): {
  current: InternalSalesMetrics;
  previous: InternalSalesMetrics;
  previousRange: DateRange;
} {
  const previousRange = getPreviousPeriod(range);
  return {
    current: computeInternalSalesMetrics(leads, range, mode),
    previous: computeInternalSalesMetrics(leads, previousRange, mode),
    previousRange,
  };
}

/** Delta in percentage points (or null if either side missing). */
export function rateDelta(
  current: number | null,
  previous: number | null
): number | null {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

export function countDelta(current: number, previous: number): number {
  return current - previous;
}

export function isCountingMode(v: string | null | undefined): v is CountingMode {
  return v === "activity" || v === "cohort";
}
