/**
 * GHL API client using OAuth location-level tokens.
 * Tokens are stored in Redis per locationId (from OAuth callback).
 */

import { isoToLocalDateString } from "@/lib/date-ranges";

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

/** Created date vs last activity for bucketing (funnel, monthly, By ad). */
export type AttributionMode = "created" | "lastUpdated";

/**
 * Extract status string from opportunity. GHL schema: status is a string ("open", "won", "lost", "abandoned").
 * Handles camelCase (status), snake_case (opportunity_status), and nested objects.
 */
function getOpportunityStatus(opp: GHLOpportunity): string {
  const raw =
    (opp.status as string) ??
    (opp as Record<string, unknown>).opportunity_status ??
    (opp as Record<string, unknown>).opportunityStatus;
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    return String(obj.name ?? obj.value ?? "").trim();
  }
  return String(raw).trim();
}

/** True when GHL marks the opportunity won (counts as success regardless of stage). */
export function isOpportunityWon(opp: GHLOpportunity): boolean {
  const s = getOpportunityStatus(opp);
  return s.toLowerCase() === "won";
}

/**
 * Local calendar date (YYYY-MM-DD) for Created vs Last Updated attribution.
 * lastUpdated: stage/status change → record update → created (aligned with monthly + funnel).
 * created: created timestamp only.
 */
export function getOpportunityAttributionLocalDate(
  opp: GHLOpportunity,
  mode: AttributionMode
): string | null {
  const lastChange =
    (opp.lastStageChangeAt as string) ??
    ((opp as Record<string, unknown>).last_stage_change_at as string) ??
    (opp.lastStatusChangeAt as string) ??
    ((opp as Record<string, unknown>).last_status_change_at as string);
  const updated =
    (opp.dateUpdated as string) ??
    ((opp as Record<string, unknown>).updated_at as string) ??
    ((opp as Record<string, unknown>).date_updated as string);
  const created =
    (opp.dateCreated as string) ??
    (opp.date_created as string) ??
    (opp.createdAt as string);
  const raw =
    mode === "lastUpdated" ? (lastChange ?? updated ?? created) : created;
  return raw ? isoToLocalDateString(raw) : null;
}

export interface DateRangeFilter {
  startDate: string; // ISO date YYYY-MM-DD
  endDate: string;
}

export function ghlAuthHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

/** GET requests — omit Content-Type (some GHL routes are picky). */
export function ghlAuthHeadersGet(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

const GHL_MAX_PAGES = 40; // Safety limit; date-based exit can stop earlier
const GHL_DELAY_MS = 150; // Delay between pagination requests to avoid 429
const GHL_429_RETRY_MS = 3000; // Wait before retry on rate limit

export function ghlDelay(ms: number): Promise<void> {
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
    headers: ghlAuthHeaders(accessToken),
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
  // GHL /opportunities/search can return the same opp on multiple pages (default
  // sort isn't stable under concurrent updates). Dedupe by id so counts match
  // getOpportunityNamesForCell and ghl-attribution's by-ad aggregation.
  const seenOpp = new Set<string>();

  while (hasMore) {
    if (page > 1) await ghlDelay(GHL_DELAY_MS);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("status", "all"); // Include won/lost/abandoned (default is "open" only)
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: ghlAuthHeaders(accessToken),
    });

    if (searchRes.status === 429) {
      await ghlDelay(GHL_429_RETRY_MS);
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
      if (seenOpp.has(opp.id)) continue;
      seenOpp.add(opp.id);

      if (dateRange) {
        const created =
          (opp.dateCreated as string) ??
          (opp.date_created as string) ??
          (opp.createdAt as string);
        if (created) {
          const dateStr = isoToLocalDateString(created);
          if (dateStr && (dateStr < dateRange.startDate || dateStr > dateRange.endDate)) {
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

      if (isOpportunityWon(opp)) {
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
 *
 * Optional `onOpp` callback fires for EVERY opportunity (regardless of whether
 * it falls inside the monthRanges window). The callback receives the raw opp
 * plus the resolved stage name so the caller can compute pipeline-wide signals
 * (e.g. stale-open backlog, last manual activity) without making a second API
 * call. Emitted once per deduped opportunity id.
 */
export async function getOpportunityCountsByStagePerMonth(
  locationId: string,
  pipeline: GHLPipeline,
  accessToken: string,
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>,
  attributionMode: AttributionMode = "lastUpdated",
  opts?: {
    onOpp?: (opp: GHLOpportunity, stageName: string) => void;
  }
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
  // GHL /opportunities/search can return the same opp on multiple pages (default
  // sort isn't stable under concurrent updates). Dedupe by id so monthly counts
  // match getOpportunityNamesForCell's deduped drill-down.
  const seenOpp = new Set<string>();

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
    if (page > 1) await ghlDelay(GHL_DELAY_MS);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("status", "all"); // Include won/lost/abandoned (default is "open" only)
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: ghlAuthHeaders(accessToken),
    });

    if (searchRes.status === 429) {
      await ghlDelay(GHL_429_RETRY_MS);
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
      if (seenOpp.has(opp.id)) continue;
      seenOpp.add(opp.id);

      // Resolve stage name up-front so the quality callback can see it even
      // for won opps (won collapses to STATUS_WON_KEY in bucketing, but the
      // caller might want the real stage name for its own signals).
      const resolvedStageName =
        opp.stageName ??
        (opp.pipelineStageId
          ? stageIdToName.get(opp.pipelineStageId as string)
          : null) ??
        (opp.pipelineStageId as string) ??
        "Unknown";

      // Fire the quality callback unconditionally — it runs regardless of
      // whether the opp falls inside the monthRanges window (stale-open
      // backlog counts opps that may predate the window, for example).
      opts?.onOpp?.(opp, resolvedStageName);

      const dateStr = getOpportunityAttributionLocalDate(opp, attributionMode);
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

      if (isOpportunityWon(opp)) {
        bucket.counts[STATUS_WON_KEY] = (bucket.counts[STATUS_WON_KEY] ?? 0) + 1;
        bucket.values[STATUS_WON_KEY] = (bucket.values[STATUS_WON_KEY] ?? 0) + val;
      } else {
        bucket.counts[resolvedStageName] =
          (bucket.counts[resolvedStageName] ?? 0) + 1;
        bucket.values[resolvedStageName] =
          (bucket.values[resolvedStageName] ?? 0) + val;
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

/** Shape for rollup drill-down groups (matches funnel-metrics RollupGroup) */
interface RollupGroup {
  label: string;
  stageKeys: string[];
}

/**
 * Fetch opportunity names for a specific cell (monthKey + metric). Used for drill-down.
 * When rollupGroups is provided (On Totals mode), returns namesByStage grouped by label.
 */
export async function getOpportunityNamesForCell(
  locationId: string,
  pipeline: GHLPipeline,
  accessToken: string,
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>,
  attributionMode: AttributionMode,
  targetMonthKey: string,
  contributingStageKeys: string[],
  rollupGroups?: RollupGroup[]
): Promise<{ names: string[]; namesByStage?: Record<string, string[]> }> {
  const stageIdToName = buildStageIdToName(pipeline.stages);
  const limit = 100;
  let page = 1;
  const names: string[] = [];
  const namesByStage: Record<string, string[]> | undefined = rollupGroups
    ? Object.fromEntries(rollupGroups.map((g) => [g.label, []]))
    : undefined;
  const seen = new Set<string>();
  const keySet = new Set(contributingStageKeys.map((k) => k.toLowerCase()));
  const stageToGroupLabel = rollupGroups
    ? (() => {
        const m = new Map<string, string>();
        for (const g of rollupGroups) {
          for (const k of g.stageKeys) {
            m.set(k.toLowerCase(), g.label);
          }
        }
        return m;
      })()
    : null;

  const getMonthForDate = (dateStr: string) => {
    for (const range of monthRanges) {
      if (dateStr >= range.startDate && dateStr <= range.endDate) return range.monthKey;
    }
    return null;
  };

  const oldestMonthStart = monthRanges.length > 0 ? monthRanges[monthRanges.length - 1].startDate : null;

  while (page <= GHL_MAX_PAGES) {
    if (page > 1) await ghlDelay(GHL_DELAY_MS);
    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("status", "all");
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: ghlAuthHeaders(accessToken),
    });
    if (searchRes.status === 429) {
      await ghlDelay(GHL_429_RETRY_MS);
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
      const dateStr = getOpportunityAttributionLocalDate(opp, attributionMode);
      if (dateStr) {
        if (!minDateInPage || dateStr < minDateInPage) minDateInPage = dateStr;
      }
      const monthKey = dateStr ? getMonthForDate(dateStr) : null;
      if (monthKey !== targetMonthKey) continue;

      let bucketKey: string;
      if (isOpportunityWon(opp)) {
        bucketKey = STATUS_WON_KEY;
      } else {
        bucketKey =
          opp.stageName ??
          (opp.pipelineStageId
            ? stageIdToName.get(opp.pipelineStageId as string)
            : null) ??
          (opp.pipelineStageId as string) ??
          "Unknown";
      }
      if (!keySet.has(bucketKey.toLowerCase())) continue;

      const name = (opp.name as string) ?? (opp as Record<string, unknown>).opportunityName as string ?? `Opportunity ${opp.id}`;
      const displayName = name || `Opportunity ${opp.id}`;
      if (!seen.has(opp.id)) {
        seen.add(opp.id);
        if (namesByStage && stageToGroupLabel) {
          const groupLabel = stageToGroupLabel.get(bucketKey.toLowerCase());
          if (groupLabel && namesByStage[groupLabel]) {
            namesByStage[groupLabel].push(displayName);
          }
        }
        names.push(displayName);
      }
    }

    if (opportunities.length < limit) break;
    if (total > 0 && page * limit >= total) break;
    if (oldestMonthStart && minDateInPage && minDateInPage < oldestMonthStart) break;
    page += 1;
  }

  return namesByStage ? { names, namesByStage } : { names };
}
