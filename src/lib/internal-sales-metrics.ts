/**
 * Internal Sales metric calculations from Appointments sheet rows.
 *
 * Rates:
 *   Booking = booked / leads
 *   Show    = showed / (showed + no_showed)  — cancel/reschedule excluded
 *   Close   = signed / showed
 *   Qualified = yes / (yes + no)
 *
 * Attribution columns (Appointments sheet):
 *   utmCampaign → Campaign
 *   utmMedium   → Ad set
 *   utmContent  → Ad
 *   utmSource   → Source
 */

import type { DateRange } from "@/lib/date-ranges";
import { getMonthsBack, getPreviousPeriod } from "@/lib/date-ranges";
import type { InternalSalesLead } from "@/lib/internal-sales-sheet";

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

/** Min/max appt or creation date across leads (YYYY-MM-DD), if any. */
export function getLeadDateSpan(
  leads: InternalSalesLead[]
): { min: string; max: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const lead of leads) {
    for (const d of [lead.apptDate, lead.creationDate]) {
      if (!d) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
  }
  return min && max ? { min, max } : null;
}

export function filterLeadsByAttribution(
  leads: InternalSalesLead[],
  filters: AttributionFilters
): InternalSalesLead[] {
  return leads.filter(
    (l) =>
      matchesAnyAttr([l.utmCampaign, l.campaignId], filters.campaigns) &&
      matchesAnyAttr([l.utmMedium, l.adSetId], filters.adSets) &&
      matchesAnyAttr([l.utmContent], filters.ads) &&
      matchesAnyAttr([l.utmSource], filters.sources)
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

/** Dropdown options. When a parent filter is set, child lists narrow to matching rows. */
export function listAttributionOptions(
  leads: InternalSalesLead[],
  filters: AttributionFilters = {}
): AttributionFilterOptions {
  const forCampaigns = leads;
  const forAdSets = filters.campaigns?.length
    ? filterLeadsByAttribution(leads, { campaigns: filters.campaigns })
    : leads;
  const forAds = filterLeadsByAttribution(leads, {
    campaigns: filters.campaigns,
    adSets: filters.adSets,
  });

  return {
    campaigns: uniqueSorted(forCampaigns.map((l) => l.utmCampaign)),
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
  dimension: AttributionDimension
): AttributionBreakdownRow[] {
  const groups = new Map<string, InternalSalesLead[]>();
  for (const lead of leads) {
    if (!isLeadInRange(lead, range)) continue;
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
      metrics: computeInternalSalesMetrics(group, range),
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

/**
 * Include in lead/booking pool if appt date is in range, OR creation/booking
 * date is in range (covers leads booked this period with no/future appt).
 */
function isLeadInRange(lead: InternalSalesLead, range: DateRange): boolean {
  if (lead.apptDate && inRange(lead.apptDate, range)) return true;
  if (lead.creationDate && inRange(lead.creationDate, range)) return true;
  // No creation date, appt outside range → exclude
  // No dates at all → exclude
  return false;
}

function isApptInRange(lead: InternalSalesLead, range: DateRange): boolean {
  return !!(lead.apptDate && inRange(lead.apptDate, range));
}

function isBooked(lead: InternalSalesLead): boolean {
  return !!(lead.apptDate || lead.creationDate);
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

export function computeInternalSalesMetrics(
  leads: InternalSalesLead[],
  range: DateRange
): InternalSalesMetrics {
  const counts = emptyCounts();

  for (const lead of leads) {
    if (!isLeadInRange(lead, range)) continue;

    counts.leads += 1;
    if (isBooked(lead)) counts.booked += 1;

    if (lead.qualified === "yes") counts.qualifiedYes += 1;
    else if (lead.qualified === "no") counts.qualifiedNo += 1;
    else counts.qualifiedUnknown += 1;

    // Show / close / cancel only when the appointment itself falls in range
    if (!isApptInRange(lead, range)) continue;

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
 * Month-to-month using the same range logic as the funnel view
 * (appt date or creation date in the calendar month).
 * Returns most recent first (matches client conversions Month to Month).
 */
export function computeMonthlyMetrics(
  leads: InternalSalesLead[],
  months = 13,
  todayOverride?: string
): InternalSalesMonthRow[] {
  const ranges = getMonthsBack(months, todayOverride);
  return ranges.map((r) => {
    const metrics = computeInternalSalesMetrics(leads, r);
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
  range: DateRange
): {
  current: InternalSalesMetrics;
  previous: InternalSalesMetrics;
  previousRange: DateRange;
} {
  const previousRange = getPreviousPeriod(range);
  return {
    current: computeInternalSalesMetrics(leads, range),
    previous: computeInternalSalesMetrics(leads, previousRange),
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
