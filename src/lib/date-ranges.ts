/**
 * Date range presets for filtering opportunities.
 * All dates are YYYY-MM-DD (start of day).
 */

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

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30: "Last 30 days",
  last_60: "Last 60 days",
  last_90: "Last 90 days",
  custom: "Custom range",
};
