import { NextResponse } from "next/server";
import {
  DATE_RANGE_LABELS,
  getDateRangeForPreset,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { fetchInternalSalesLeads } from "@/lib/internal-sales-sheet";
import {
  computeInternalSalesMetrics,
  computeMonthlyMetrics,
  computeWithCompare,
} from "@/lib/internal-sales-metrics";

export const dynamic = "force-dynamic";

const PRESETS: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_3",
  "last_7",
  "last_14",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

function isPreset(v: string | null): v is DateRangePreset {
  return !!v && (PRESETS as string[]).includes(v);
}

/**
 * GET /api/agency/internal-sales
 *
 * Query:
 *   view=funnel|monthly   (default funnel)
 *   preset=last_30|...
 *   dateFrom / dateTo     (custom)
 *   clientDate            (YYYY-MM-DD from browser tz)
 *   compare=true
 *   months=13             (monthly view)
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view") === "monthly" ? "monthly" : "funnel";
    const presetParam = searchParams.get("preset") ?? searchParams.get("dateRange");
    const preset: DateRangePreset = isPreset(presetParam) ? presetParam : "last_30";
    const dateFrom = searchParams.get("dateFrom") ?? searchParams.get("from") ?? undefined;
    const dateTo = searchParams.get("dateTo") ?? searchParams.get("to") ?? undefined;
    const clientDate = searchParams.get("clientDate") ?? undefined;
    const compare = searchParams.get("compare") === "true";
    const monthsRaw = Number(searchParams.get("months") ?? 13);
    const months = Number.isFinite(monthsRaw)
      ? Math.min(24, Math.max(3, Math.floor(monthsRaw)))
      : 13;

    const { leads, fetchedAt, error, fromCache } =
      await fetchInternalSalesLeads();

    if (error && leads.length === 0) {
      return NextResponse.json(
        { error },
        {
          status: 502,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    if (view === "monthly") {
      const monthly = computeMonthlyMetrics(leads, months, clientDate);
      return NextResponse.json(
        {
          view: "monthly",
          months: monthly,
          rowCount: leads.length,
          fetchedAt,
          fromCache,
          warning: error || undefined,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const range = getDateRangeForPreset(preset, dateFrom, dateTo, clientDate);

    if (compare) {
      const { current, previous, previousRange } = computeWithCompare(
        leads,
        range
      );
      return NextResponse.json(
        {
          view: "funnel",
          range: {
            preset,
            startDate: range.startDate,
            endDate: range.endDate,
            label: DATE_RANGE_LABELS[preset],
          },
          previousRange,
          metrics: current,
          previousMetrics: previous,
          rowCount: leads.length,
          fetchedAt,
          fromCache,
          warning: error || undefined,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const metrics = computeInternalSalesMetrics(leads, range);
    return NextResponse.json(
      {
        view: "funnel",
        range: {
          preset,
          startDate: range.startDate,
          endDate: range.endDate,
          label: DATE_RANGE_LABELS[preset],
        },
        metrics,
        previousMetrics: null,
        previousRange: null,
        rowCount: leads.length,
        fetchedAt,
        fromCache,
        warning: error || undefined,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[internal-sales] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to load internal sales",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
