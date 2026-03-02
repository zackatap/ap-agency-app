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

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function getDateRangeForPreset(
  preset: DateRangePreset,
  customFrom?: string,
  customTo?: string
): DateRange {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  switch (preset) {
    case "this_month": {
      const start = startOfMonth(today);
      const end = today;
      return { startDate: toISO(start), endDate: toISO(end) };
    }
    case "last_month": {
      const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1);
      const start = startOfMonth(prevMonth);
      const end = endOfMonth(prevMonth);
      return { startDate: toISO(start), endDate: toISO(end) };
    }
    case "last_30": {
      const start = new Date(today);
      start.setDate(start.getDate() - 30);
      return { startDate: toISO(start), endDate: toISO(today) };
    }
    case "last_60": {
      const start = new Date(today);
      start.setDate(start.getDate() - 60);
      return { startDate: toISO(start), endDate: toISO(today) };
    }
    case "last_90": {
      const start = new Date(today);
      start.setDate(start.getDate() - 90);
      return { startDate: toISO(start), endDate: toISO(today) };
    }
    case "custom": {
      if (customFrom && customTo) {
        return { startDate: customFrom, endDate: customTo };
      }
      return { startDate: toISO(today), endDate: toISO(today) };
    }
    default:
      return { startDate: toISO(today), endDate: toISO(today) };
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
