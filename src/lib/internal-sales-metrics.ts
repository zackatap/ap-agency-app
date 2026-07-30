/**
 * Internal Sales metric calculations from Appointments sheet rows.
 *
 * Rates:
 *   Booking = booked / leads
 *   Show    = showed / (showed + no_showed)  — cancel/reschedule excluded
 *   Close   = signed / showed
 *   Qualified = yes / (yes + no)
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
