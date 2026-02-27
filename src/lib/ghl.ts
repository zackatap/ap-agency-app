/**
 * GoHighLevel API client for Opportunities & Pipelines
 * Base URL: https://services.leadconnectorhq.com
 *
 * Agency-level tokens only have agency scopes (locations, oauth, etc).
 * We exchange for a location-level token via POST /oauth/locationToken
 * to access opportunities (which require sub-account scopes).
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
  [key: string]: unknown;
}

function getAgencyToken(): string {
  const token = process.env.GHL_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GHL_ACCESS_TOKEN is not configured");
  }
  return token;
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
  };
}

/**
 * Exchange agency token for location-level token.
 * Requires: locations.readonly (to get companyId), oauth.write (to exchange).
 */
async function getLocationAccessToken(locationId: string): Promise<string> {
  const agencyToken = getAgencyToken();

  // 1. Get location details (companyId) - locations.readonly
  const locationRes = await fetch(
    `${GHL_BASE}/locations/${locationId}`,
    { headers: authHeaders(agencyToken) }
  );
  if (!locationRes.ok) {
    const err = await locationRes.text();
    throw new Error(`GHL getLocation failed: ${locationRes.status} ${err}`);
  }
  const locationData = await locationRes.json();
  const loc = locationData.location ?? locationData; // Response may wrap in { location: {...} }
  const companyId =
    loc.companyId ??
    loc.company_id ??
    loc.parentCompanyId ??
    loc.parentCompany_id ??
    loc.company?.id;
  if (!companyId) {
    // Fallback 1: Try locationToken with only locationId
    const tokenResNoCompany = await fetch(`${GHL_BASE}/oauth/locationToken`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${agencyToken}`,
        Version: API_VERSION,
      },
      body: new URLSearchParams({ locationId }),
    });
    if (tokenResNoCompany.ok) {
      const tokenData = await tokenResNoCompany.json();
      const token =
        tokenData.access_token ?? tokenData.locationAccessToken ?? tokenData.token;
      if (token) return token;
    }
    // Fallback 2: Get company from GET /companies (companies.readonly) - use first company
    const companiesRes = await fetch(`${GHL_BASE}/companies`, {
      headers: authHeaders(agencyToken),
    });
    if (companiesRes.ok) {
      const companiesData = await companiesRes.json();
      const companies = companiesData.companies ?? companiesData;
      const firstCompany = Array.isArray(companies) ? companies[0] : companies;
      const cid = firstCompany?.id ?? firstCompany?.companyId;
      if (cid) {
        const tokenRes2 = await fetch(`${GHL_BASE}/oauth/locationToken`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${agencyToken}`,
            Version: API_VERSION,
          },
          body: new URLSearchParams({ companyId: cid, locationId }),
        });
        if (tokenRes2.ok) {
          const tokenData = await tokenRes2.json();
          const token =
            tokenData.access_token ?? tokenData.locationAccessToken ?? tokenData.token;
          if (token) return token;
        }
      }
    }
    throw new Error(
      `Location response missing companyId. Location keys: ${Object.keys(loc).join(", ")}. ` +
        "Ensure agency token has locations.readonly and oauth.write scopes."
    );
  }

  // 2. Exchange for location token - oauth.write
  const tokenRes = await fetch(`${GHL_BASE}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${agencyToken}`,
      Version: API_VERSION,
    },
    body: new URLSearchParams({
      companyId,
      locationId,
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(
      `GHL locationToken failed: ${tokenRes.status} ${err}. Agency token may need oauth.write scope.`
    );
  }
  const tokenData = await tokenRes.json();
  const locationToken =
    tokenData.access_token ?? tokenData.locationAccessToken ?? tokenData.token;
  if (!locationToken) {
    throw new Error("Location token response missing access_token");
  }
  return locationToken;
}

/**
 * Get all pipelines for a location.
 * Uses agency token -> location token exchange for agency-level integrations.
 */
export async function getPipelines(locationId: string): Promise<GHLPipeline[]> {
  const locationToken = await getLocationAccessToken(locationId);

  const url = new URL("/opportunities/pipelines", GHL_BASE);
  url.searchParams.set("locationId", locationId);

  const res = await fetch(url.toString(), {
    headers: authHeaders(locationToken),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL getPipelines failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  const pipelines = data.pipelines ?? data;
  return Array.isArray(pipelines) ? pipelines : [];
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
 * Fetch all opportunities for a pipeline (paginated), including won/lost - no status filter.
 * Aggregates counts by stage name for conversion metrics.
 */
export async function getOpportunityCountsByStage(
  locationId: string,
  pipeline: GHLPipeline
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const stageIdToName = buildStageIdToName(pipeline.stages);
  let skip = 0;
  const limit = 100;
  let hasMore = true;

  const locationToken = await getLocationAccessToken(locationId);

  while (hasMore) {
    // Try POST /opportunities/search first (common GHL pattern)
    const searchRes = await fetch(`${GHL_BASE}/opportunities/search`, {
      method: "POST",
      headers: authHeaders(locationToken),
      body: JSON.stringify({
        locationId,
        pipelineId: pipeline.id,
        limit,
        skip,
        // Explicitly do NOT pass status - we want all opps including won
      }),
    });

    let opportunities: GHLOpportunity[] = [];
    let total = 0;

    if (searchRes.ok) {
      const data = await searchRes.json();
      opportunities = data.opportunities ?? data.data ?? [];
      total = data.total ?? data.totalCount ?? opportunities.length;
    } else {
      // Fallback: try GET with query params
      const listUrl = new URL("/opportunities/", GHL_BASE);
      listUrl.searchParams.set("locationId", locationId);
      listUrl.searchParams.set("pipelineId", pipeline.id);
      listUrl.searchParams.set("limit", String(limit));
      listUrl.searchParams.set("skip", String(skip));
      const listRes = await fetch(listUrl.toString(), {
        headers: authHeaders(locationToken),
      });
      if (!listRes.ok) {
        const err = await searchRes.text();
        throw new Error(`GHL getOpportunities failed: ${searchRes.status} ${err}`);
      }
      const data = await listRes.json();
      opportunities = data.opportunities ?? data.data ?? [];
      total = data.total ?? opportunities.length;
    }

    for (const opp of opportunities) {
      const stageName =
        opp.stageName ??
        (opp.pipelineStageId
          ? stageIdToName.get(opp.pipelineStageId as string)
          : null) ??
        (opp.pipelineStageId as string) ??
        "Unknown";
      counts[stageName] = (counts[stageName] ?? 0) + 1;
    }

    skip += opportunities.length;
    hasMore = opportunities.length === limit && skip < (total || Infinity);
  }

  return counts;
}
