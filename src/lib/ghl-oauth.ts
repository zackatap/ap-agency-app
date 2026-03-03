/**
 * GHL API client using OAuth location-level tokens.
 * Tokens are stored in Redis per locationId (from OAuth callback).
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export interface GHLPipelineStage {
  id: string;
  name: string;
  position?: number;
}

export interface GHLPipeline {
  id: string;
  name: string;
  stages?: GHLPipelineStage[];
}

export interface GHLOpportunity {
  id: string;
  pipelineId?: string;
  pipelineStageId?: string;
  stageName?: string;
  status?: string;
  locationId?: string;
  dateCreated?: string;
  dateUpdated?: string;
  monetaryValue?: number; // GHL opportunity value in dollars
  [key: string]: unknown;
}

export interface StageMetrics {
  counts: Record<string, number>;
  values: Record<string, number>; // sum of monetaryValue per stage
}

/** Opportunities with status "won" count as closed regardless of stage. Exported for funnel-metrics. */
export const STATUS_WON_KEY = "__closed_by_status";

function isWonStatus(opp: GHLOpportunity): boolean {
  const s =
    (opp.status as string) ??
    (opp as Record<string, unknown>).opportunity_status as string ??
    "";
  return s.toLowerCase().trim() === "won";
}

export interface DateRangeFilter {
  startDate: string; // ISO date YYYY-MM-DD
  endDate: string;
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

const GHL_MAX_PAGES = 40; // Safety limit; date-based exit can stop earlier
const GHL_DELAY_MS = 150; // Delay between pagination requests to avoid 429
const GHL_429_RETRY_MS = 3000; // Wait before retry on rate limit

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map pipelineStageId -> stage name for aggregating by name */
function buildStageIdToName(
  stages: GHLPipelineStage[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!stages) return map;
  for (const s of stages) {
    map.set(s.id, s.name);
  }
  return map;
}

/**
 * Get all pipelines for a location (requires OAuth location token)
 */
export async function getPipelines(
  locationId: string,
  accessToken: string
): Promise<GHLPipeline[]> {
  const url = new URL("/opportunities/pipelines", GHL_BASE);
  url.searchParams.set("locationId", locationId);

  const res = await fetch(url.toString(), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL getPipelines failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  const pipelines = data.pipelines ?? data;
  return Array.isArray(pipelines) ? pipelines : [];
}

/**
 * Fetch all opportunities for a pipeline, including won.
 * Uses GET /opportunities/search with query params per GHL official SDK.
 * Supports optional date range filtering; uses API params when available,
 * otherwise filters by dateCreated client-side.
 */
export async function getOpportunityCountsByStage(
  locationId: string,
  pipeline: GHLPipeline,
  accessToken: string,
  dateRange?: DateRangeFilter
): Promise<StageMetrics> {
  const counts: Record<string, number> = {};
  const values: Record<string, number> = {};
  const stageIdToName = buildStageIdToName(pipeline.stages);
  const limit = 100;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (page > 1) await delay(GHL_DELAY_MS);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: authHeaders(accessToken),
    });

    if (searchRes.status === 429) {
      await delay(GHL_429_RETRY_MS);
      continue; // Retry same page
    }

    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`GHL getOpportunities failed: ${searchRes.status} ${err}`);
    }

    const data = await searchRes.json();
    const opportunities: GHLOpportunity[] = data.opportunities ?? data.data ?? [];
    const total = data.total ?? data.totalCount ?? 0;

    for (const opp of opportunities) {
      if (dateRange) {
        const created =
          (opp.dateCreated as string) ??
          (opp.date_created as string) ??
          (opp.createdAt as string);
        if (created) {
          const dateStr = created.split("T")[0];
          if (dateStr < dateRange.startDate || dateStr > dateRange.endDate) {
            continue;
          }
        }
      }

      const val =
        typeof opp.monetaryValue === "number"
          ? opp.monetaryValue
          : typeof (opp as Record<string, unknown>).monetary_value === "number"
            ? ((opp as Record<string, unknown>).monetary_value as number)
            : 0;

      if (isWonStatus(opp)) {
        counts[STATUS_WON_KEY] = (counts[STATUS_WON_KEY] ?? 0) + 1;
        values[STATUS_WON_KEY] = (values[STATUS_WON_KEY] ?? 0) + val;
      } else {
        const stageName =
          opp.stageName ??
          (opp.pipelineStageId
            ? stageIdToName.get(opp.pipelineStageId as string)
            : null) ??
          (opp.pipelineStageId as string) ??
          "Unknown";
        counts[stageName] = (counts[stageName] ?? 0) + 1;
        values[stageName] = (values[stageName] ?? 0) + val;
      }
    }

    page += 1;
    hasMore =
      opportunities.length === limit &&
      page <= GHL_MAX_PAGES &&
      (total === 0 || page * limit <= total);
  }

  return { counts, values };
}

/**
 * Fetch all opportunities once, bucket by month. Used by monthly API to avoid
 * N×months API calls (which causes 429). Single pipeline fetch, aggregate in memory.
 */
export async function getOpportunityCountsByStagePerMonth(
  locationId: string,
  pipeline: GHLPipeline,
  accessToken: string,
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>
): Promise<
  Array<{
    monthKey: string;
    startDate: string;
    endDate: string;
    counts: Record<string, number>;
    values: Record<string, number>;
  }>
> {
  const stageIdToName = buildStageIdToName(pipeline.stages);
  const limit = 100;
  let page = 1;

  const byMonth = new Map<
    string,
    { counts: Record<string, number>; values: Record<string, number> }
  >();
  for (const range of monthRanges) {
    byMonth.set(range.monthKey, { counts: {}, values: {} });
  }

  const getMonthForDate = (dateStr: string) => {
    for (const range of monthRanges) {
      if (dateStr >= range.startDate && dateStr <= range.endDate) return range.monthKey;
    }
    return null;
  };

  const oldestMonthStart = monthRanges.length > 0
    ? monthRanges[monthRanges.length - 1].startDate
    : null;

  while (page <= GHL_MAX_PAGES) {
    if (page > 1) await delay(GHL_DELAY_MS);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: authHeaders(accessToken),
    });

    if (searchRes.status === 429) {
      await delay(GHL_429_RETRY_MS);
      continue;
    }

    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`GHL getOpportunities failed: ${searchRes.status} ${err}`);
    }

    const data = await searchRes.json();
    const opportunities: GHLOpportunity[] = data.opportunities ?? data.data ?? [];
    const total = data.total ?? data.totalCount ?? 0;

    let minDateInPage: string | null = null;

    for (const opp of opportunities) {
      const created =
        (opp.dateCreated as string) ??
        (opp.date_created as string) ??
        (opp.createdAt as string);
      const dateStr = created ? created.split("T")[0] : null;
      if (dateStr) {
        if (!minDateInPage || dateStr < minDateInPage) minDateInPage = dateStr;
      }
      const monthKey = dateStr ? getMonthForDate(dateStr) : null;
      if (!monthKey) continue;

      const bucket = byMonth.get(monthKey)!;
      const val =
        typeof opp.monetaryValue === "number"
          ? opp.monetaryValue
          : typeof (opp as Record<string, unknown>).monetary_value === "number"
            ? ((opp as Record<string, unknown>).monetary_value as number)
            : 0;

      if (isWonStatus(opp)) {
        bucket.counts[STATUS_WON_KEY] = (bucket.counts[STATUS_WON_KEY] ?? 0) + 1;
        bucket.values[STATUS_WON_KEY] = (bucket.values[STATUS_WON_KEY] ?? 0) + val;
      } else {
        const stageName =
          opp.stageName ??
          (opp.pipelineStageId
            ? stageIdToName.get(opp.pipelineStageId as string)
            : null) ??
          (opp.pipelineStageId as string) ??
          "Unknown";
        bucket.counts[stageName] = (bucket.counts[stageName] ?? 0) + 1;
        bucket.values[stageName] = (bucket.values[stageName] ?? 0) + val;
      }
    }

    if (opportunities.length < limit) break;
    if (total > 0 && page * limit >= total) break;
    if (oldestMonthStart && minDateInPage && minDateInPage < oldestMonthStart) break;
    page += 1;
  }

  return monthRanges.map((range) => {
    const bucket = byMonth.get(range.monthKey)!;
    return {
      monthKey: range.monthKey,
      startDate: range.startDate,
      endDate: range.endDate,
      counts: bucket.counts,
      values: bucket.values,
    };
  });
}
