import { NextResponse } from "next/server";
import {
  DATE_RANGE_LABELS,
  getDateRangeForPreset,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { fetchInternalSalesLeads } from "@/lib/internal-sales-sheet";
import {
  computeAttributionBreakdown,
  computeInternalSalesMetrics,
  computeMonthlyMetrics,
  computeWithCompare,
  filterLeadsByAttribution,
  listAttributionOptions,
  type AttributionDimension,
  type AttributionFilters,
} from "@/lib/internal-sales-metrics";
import {
  costsFromSpend,
  fetchFilteredAdInsights,
  fetchMonthlySpend,
  spendForBreakdownKey,
  sumInsightSpend,
} from "@/lib/internal-sales-spend";

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

const DIMENSIONS: AttributionDimension[] = [
  "ad",
  "adSet",
  "campaign",
  "source",
];

function isPreset(v: string | null): v is DateRangePreset {
  return !!v && (PRESETS as string[]).includes(v);
}

function isDimension(v: string | null): v is AttributionDimension {
  return !!v && (DIMENSIONS as string[]).includes(v);
}

/** Read multi-select filters from repeated params and/or comma-separated values. */
function readMultiParam(searchParams: URLSearchParams, key: string): string[] {
  const values: string[] = [];
  for (const raw of searchParams.getAll(key)) {
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (v) values.push(v);
    }
  }
  return [...new Set(values)];
}

function readFilters(searchParams: URLSearchParams): AttributionFilters {
  const campaigns = readMultiParam(searchParams, "campaign");
  const adSets = readMultiParam(searchParams, "adSet");
  const ads = readMultiParam(searchParams, "ad");
  const sources = readMultiParam(searchParams, "source");
  return {
    campaigns: campaigns.length ? campaigns : undefined,
    adSets: adSets.length ? adSets : undefined,
    ads: ads.length ? ads : undefined,
    sources: sources.length ? sources : undefined,
  };
}

/**
 * GET /api/agency/internal-sales
 *
 * Query:
 *   view=funnel|monthly|attribution
 *   preset=last_30|...
 *   dateFrom / dateTo
 *   clientDate
 *   compare=true
 *   months=13
 *   campaign / adSet / ad / source
 *   dimension=ad|adSet|campaign|source
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const viewParam = searchParams.get("view");
    const view =
      viewParam === "monthly" || viewParam === "attribution"
        ? viewParam
        : "funnel";
    const presetParam =
      searchParams.get("preset") ?? searchParams.get("dateRange");
    const preset: DateRangePreset = isPreset(presetParam)
      ? presetParam
      : "last_30";
    const dateFrom =
      searchParams.get("dateFrom") ?? searchParams.get("from") ?? undefined;
    const dateTo =
      searchParams.get("dateTo") ?? searchParams.get("to") ?? undefined;
    const clientDate = searchParams.get("clientDate") ?? undefined;
    const compare = searchParams.get("compare") === "true";
    const monthsRaw = Number(searchParams.get("months") ?? 13);
    const months = Number.isFinite(monthsRaw)
      ? Math.min(24, Math.max(3, Math.floor(monthsRaw)))
      : 13;
    const dimension: AttributionDimension = isDimension(
      searchParams.get("dimension")
    )
      ? (searchParams.get("dimension") as AttributionDimension)
      : "ad";
    const filters = readFilters(searchParams);

    const { leads: allLeads, fetchedAt, error, fromCache } =
      await fetchInternalSalesLeads();

    if (error && allLeads.length === 0) {
      return NextResponse.json(
        { error },
        {
          status: 502,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const leads = filterLeadsByAttribution(allLeads, filters);
    const filterOptions = listAttributionOptions(allLeads, filters);
    const activeFilters = {
      campaigns: filters.campaigns ?? [],
      adSets: filters.adSets ?? [],
      ads: filters.ads ?? [],
      sources: filters.sources ?? [],
    };

    const baseMeta = {
      rowCount: allLeads.length,
      filteredRowCount: leads.length,
      fetchedAt,
      fromCache,
      filters: activeFilters,
      filterOptions,
      warning: error || undefined,
    };

    if (view === "monthly") {
      const monthly = computeMonthlyMetrics(leads, months, clientDate);
      const monthKeys = monthly.map((m) => m.monthKey);
      const {
        spendByMonth,
        error: spendError,
        adAccountId,
      } = await fetchMonthlySpend(monthKeys, filters);

      const monthsWithSpend = monthly.map((m) => {
        const spend = spendByMonth[m.monthKey] ?? 0;
        const costs = costsFromSpend(spend, m.metrics.counts);
        return { ...m, spend: costs.spend, costs };
      });

      return NextResponse.json(
        {
          view: "monthly",
          months: monthsWithSpend,
          spendByMonth,
          adAccountId,
          metaSpendError: spendError,
          ...baseMeta,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const range = getDateRangeForPreset(preset, dateFrom, dateTo, clientDate);

    if (view === "attribution") {
      const rows = computeAttributionBreakdown(leads, range, dimension);
      const {
        ads,
        error: spendError,
        adAccountId,
      } = await fetchFilteredAdInsights(
        range.startDate,
        range.endDate,
        filters
      );

      const rowsWithSpend = rows.map((row) => {
        const spend = spendForBreakdownKey(ads, dimension, row.key);
        const cpl =
          spend != null && row.metrics.counts.leads > 0
            ? Math.round((spend / row.metrics.counts.leads) * 100) / 100
            : null;
        const cps =
          spend != null && row.metrics.counts.showed > 0
            ? Math.round((spend / row.metrics.counts.showed) * 100) / 100
            : null;
        const cpClose =
          spend != null && row.metrics.counts.signed > 0
            ? Math.round((spend / row.metrics.counts.signed) * 100) / 100
            : null;
        return { ...row, spend, cpl, cps, cpClose };
      });

      return NextResponse.json(
        {
          view: "attribution",
          dimension,
          range: {
            preset,
            startDate: range.startDate,
            endDate: range.endDate,
            label: DATE_RANGE_LABELS[preset],
          },
          rows: rowsWithSpend,
          adAccountId,
          metaSpendError: spendError,
          ...baseMeta,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Funnel (+ optional compare)
    const {
      ads,
      error: spendError,
      adAccountId,
    } = await fetchFilteredAdInsights(
      range.startDate,
      range.endDate,
      filters
    );
    const spend = sumInsightSpend(ads);

    if (compare) {
      const { current, previous, previousRange } = computeWithCompare(
        leads,
        range
      );
      const {
        ads: prevAds,
        error: prevSpendError,
      } = await fetchFilteredAdInsights(
        previousRange.startDate,
        previousRange.endDate,
        filters
      );
      const prevSpend = sumInsightSpend(prevAds);

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
          costs: costsFromSpend(spend, current.counts),
          previousCosts: costsFromSpend(prevSpend, previous.counts),
          adAccountId,
          metaSpendError: spendError || prevSpendError,
          ...baseMeta,
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
        costs: costsFromSpend(spend, metrics.counts),
        previousCosts: null,
        adAccountId,
        metaSpendError: spendError,
        ...baseMeta,
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
