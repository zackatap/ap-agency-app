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
  dateCreated?: string; // ISO date string
  dateUpdated?: string;
  [key: string]: unknown;
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
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const stageIdToName = buildStageIdToName(pipeline.stages);
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    // GHL API may support startDate/endDate for date filtering
    if (dateRange) {
      searchUrl.searchParams.set("startDate", dateRange.startDate);
      searchUrl.searchParams.set("endDate", dateRange.endDate);
    }

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: authHeaders(accessToken),
    });

    let opportunities: GHLOpportunity[] = [];
    let total = 0;

    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`GHL getOpportunities failed: ${searchRes.status} ${err}`);
    }

    const data = await searchRes.json();
    opportunities = data.opportunities ?? data.data ?? [];
    total = data.total ?? data.totalCount ?? opportunities.length;

    for (const opp of opportunities) {
      // Client-side date filter fallback (API may not honor date params)
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

      const stageName =
        opp.stageName ??
        (opp.pipelineStageId
          ? stageIdToName.get(opp.pipelineStageId as string)
          : null) ??
        (opp.pipelineStageId as string) ??
        "Unknown";
      counts[stageName] = (counts[stageName] ?? 0) + 1;
    }

    page += 1;
    hasMore = opportunities.length === limit && page * limit < (total || Infinity);
  }

  return counts;
}
