/**
 * Date range presets for filtering opportunities.
 * All dates are YYYY-MM-DD (start of day).
 */

/** Timezone for attributing opportunity dates (GHL returns UTC). Default America/Chicago. */
const OPPORTUNITY_TIMEZONE =
  process.env.OPPORTUNITY_TIMEZONE?.trim() || "America/Chicago";

/**
 * Convert ISO UTC string (e.g. from GHL API) to YYYY-MM-DD in the configured timezone.
 * Fixes misattribution: Jan 31 10:41pm CDT was incorrectly showing as Feb 1 when using UTC.
 */
export function isoToLocalDateString(isoString: string): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: OPPORTUNITY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

export type DateRangePreset =
  | "this_month"
  | "last_month"
  | "last_30"
  | "last_60"
  | "last_90"
  | "custom";

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Format date as YYYY-MM-DD in local timezone (not UTC) */
function toLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Get today as YYYY-MM-DD in local timezone */
export function getTodayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getDateRangeForPreset(
  preset: DateRangePreset,
  customFrom?: string,
  customTo?: string,
  todayOverride?: string // YYYY-MM-DD from client for timezone consistency
): DateRange {
  const today = todayOverride
    ? (() => {
        const [y, m, d] = todayOverride.split("-").map(Number);
        return new Date(y, m - 1, d);
      })()
    : new Date();
  today.setHours(0, 0, 0, 0);

  switch (preset) {
    case "this_month": {
      const start = startOfMonth(today);
      const end = today;
      return { startDate: toLocalDate(start), endDate: toLocalDate(end) };
    }
    case "last_month": {
      const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1);
      const start = startOfMonth(prevMonth);
      const end = endOfMonth(prevMonth);
      return { startDate: toLocalDate(start), endDate: toLocalDate(end) };
    }
    case "last_30": {
      const start = new Date(today);
      start.setDate(start.getDate() - 30);
      return { startDate: toLocalDate(start), endDate: toLocalDate(today) };
    }
    case "last_60": {
      const start = new Date(today);
      start.setDate(start.getDate() - 60);
      return { startDate: toLocalDate(start), endDate: toLocalDate(today) };
    }
    case "last_90": {
      const start = new Date(today);
      start.setDate(start.getDate() - 90);
      return { startDate: toLocalDate(start), endDate: toLocalDate(today) };
    }
    case "custom": {
      if (customFrom && customTo) {
        return { startDate: customFrom, endDate: customTo };
      }
      return { startDate: toLocalDate(today), endDate: toLocalDate(today) };
    }
    default:
      return { startDate: toLocalDate(today), endDate: toLocalDate(today) };
  }
}

export interface MonthRange {
  monthKey: string; // "2026-02"
  startDate: string;
  endDate: string;
}

/** Get last N calendar months from today (or clientDate). Most recent first. */
export function getMonthsBack(
  n: number,
  todayOverride?: string // YYYY-MM-DD from client
): MonthRange[] {
  const today = todayOverride
    ? (() => {
        const [y, m, d] = todayOverride.split("-").map(Number);
        return new Date(y, m - 1, d);
      })()
    : new Date();

  const result: MonthRange[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const start = startOfMonth(d);
    const end = endOfMonth(d);
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, "0");
    result.push({
      monthKey: `${y}-${m}`,
      startDate: toLocalDate(start),
      endDate: toLocalDate(end),
    });
  }
  return result;
}

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30: "Last 30 days",
  last_60: "Last 60 days",
  last_90: "Last 90 days",
  custom: "Custom range",
};
