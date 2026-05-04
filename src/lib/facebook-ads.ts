/**
 * Meta (Facebook) Marketing API helpers.
 * Fetches campaigns and ad spend insights using a server-side access token.
 *
 * Requires:
 * - META_APP_ID (Meta app ID)
 * - META_APP_SECRET (Meta app secret)
 * - META_ACCESS_TOKEN (Long-lived token with ads_read permission)
 *   Generate via Graph API Explorer or System User in Business Manager.
 */

const META_GRAPH = "https://graph.facebook.com";
const META_API_VERSION = "v21.0";

function getAccessToken(): string | null {
  return process.env.META_ACCESS_TOKEN ?? null;
}

/** Ensure ad account ID has act_ prefix */
export function normalizeAdAccountId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

export interface FacebookCampaign {
  id: string;
  name: string;
}

/**
 * Fetch campaigns for an ad account.
 * Returns ACTIVE and PAUSED campaigns.
 */
export async function fetchCampaigns(
  adAccountId: string
): Promise<{ campaigns: FacebookCampaign[]; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { campaigns: [], error: "META_ACCESS_TOKEN not configured" };
  }

  const normalized = normalizeAdAccountId(adAccountId);
  if (!normalized) {
    return { campaigns: [], error: "Invalid ad account ID" };
  }

  const params = new URLSearchParams({
    fields: "id,name",
    effective_status: '["ACTIVE","PAUSED"]',
    access_token: token,
  });

  const url = `${META_GRAPH}/${META_API_VERSION}/${normalized}/campaigns?${params}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (json.error) {
      return {
        campaigns: [],
        error: json.error.message ?? String(json.error),
      };
    }

    const data = Array.isArray(json.data) ? json.data : [];
    const campaigns: FacebookCampaign[] = data.map((c: { id: string; name: string }) => ({
      id: c.id,
      name: c.name ?? "(Unnamed)",
    }));

    return { campaigns };
  } catch (err) {
    return {
      campaigns: [],
      error: err instanceof Error ? err.message : "Failed to fetch campaigns",
    };
  }
}

/**
 * Fetch ad spend by month for an ad account or a specific campaign.
 * @param nodeId - act_123456789 (account) or 123456789 (campaign ID)
 * @param isCampaign - true if nodeId is a campaign ID (no act_ prefix)
 * @param monthKeys - e.g. ["2024-01", "2024-02"]
 */
export async function fetchSpendByMonth(
  nodeId: string,
  isCampaign: boolean,
  monthKeys: string[]
): Promise<{ spendByMonth: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByMonth: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = isCampaign ? nodeId : normalizeAdAccountId(nodeId);
  if (!graphId) {
    return { spendByMonth: {}, error: "Invalid ad account or campaign ID" };
  }

  const spendByMonth: Record<string, number> = {};
  for (const monthKey of monthKeys) {
    spendByMonth[monthKey] = 0;
  }

  // Meta API: use time_range spanning all months + time_increment=monthly
  const sorted = [...monthKeys].sort();
  const [firstY, firstM] = sorted[0].split("-").map(Number);
  const [lastY, lastM] = sorted[sorted.length - 1].split("-").map(Number);
  const since = `${firstY}-${String(firstM).padStart(2, "0")}-01`;
  const lastDay = new Date(lastY, lastM, 0).getDate();
  const until = `${lastY}-${String(lastM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const params = new URLSearchParams({
    fields: "spend",
    access_token: token,
    time_range: JSON.stringify({ since, until }),
    time_increment: "monthly",
  });

  const url = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (json.error) {
      return { spendByMonth, error: json.error.message ?? String(json.error) };
    }

    const data = Array.isArray(json.data) ? json.data : [];
    for (const row of data) {
      const start = (row as { date_start?: string }).date_start;
      const spendVal = (row as { spend?: string }).spend;
      if (start && spendVal != null) {
        const monthKey = start.slice(0, 7);
        const val = parseFloat(String(spendVal));
        if (monthKeys.includes(monthKey)) {
          spendByMonth[monthKey] = isNaN(val) ? 0 : val;
        }
      }
    }

    return { spendByMonth };
  } catch (err) {
    return {
      spendByMonth,
      error: err instanceof Error ? err.message : "Failed to fetch insights",
    };
  }
}

/**
 * Fetch ad spend bucketed by DAY over an inclusive `[since, until]` window.
 * Returns a map keyed by YYYY-MM-DD (empty object on error). Used by the
 * agency rollup so KPIs can be sliced to arbitrary ranges.
 */
export async function fetchSpendByDay(
  nodeId: string,
  isCampaign: boolean,
  since: string,
  until: string
): Promise<{ spendByDate: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByDate: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = isCampaign ? nodeId : normalizeAdAccountId(nodeId);
  if (!graphId) {
    return { spendByDate: {}, error: "Invalid ad account or campaign ID" };
  }

  const params = new URLSearchParams({
    fields: "spend",
    access_token: token,
    time_range: JSON.stringify({ since, until }),
    time_increment: "1", // daily
  });

  let url: string | null = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;
  const spendByDate: Record<string, number> = {};

  try {
    // Meta paginates day-bucket responses — follow `paging.next` until exhausted.
    while (url) {
      const res: Response = await fetch(url);
      const json = (await res.json()) as {
        data?: Array<{ date_start?: string; spend?: string }>;
        paging?: { next?: string };
        error?: { message?: string };
      };
      if (json.error) {
        return {
          spendByDate,
          error: json.error.message ?? String(json.error),
        };
      }
      const data = Array.isArray(json.data) ? json.data : [];
      for (const row of data) {
        const day = row.date_start;
        const spendVal = row.spend;
        if (day && spendVal != null) {
          const val = parseFloat(String(spendVal));
          if (!Number.isNaN(val) && val > 0) {
            spendByDate[day] = (spendByDate[day] ?? 0) + val;
          }
        }
      }
      url = json.paging?.next ?? null;
    }
    return { spendByDate };
  } catch (err) {
    return {
      spendByDate,
      error: err instanceof Error ? err.message : "Failed to fetch daily insights",
    };
  }
}

export type MetaInsightsLevel = "campaign" | "adset" | "ad";

export interface MetaAdInsight {
  adId: string;
  adName: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  inlineLinkClicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  leads: number;
}

type MetaAction = {
  action_type?: string;
  value?: string;
};

function parseNumber(raw: unknown): number {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function parseNullableNumber(raw: unknown): number | null {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : null;
}

function parseLeadActions(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.reduce((sum, action: MetaAction) => {
    const type = String(action?.action_type ?? "").toLowerCase();
    if (!type.includes("lead")) return sum;
    return sum + parseNumber(action?.value);
  }, 0);
}

function mergeAdInsight(
  existing: MetaAdInsight | undefined,
  row: MetaAdInsight
): MetaAdInsight {
  if (!existing) return row;
  const spend = existing.spend + row.spend;
  const impressions = existing.impressions + row.impressions;
  const clicks = existing.clicks + row.clicks;
  return {
    ...existing,
    spend,
    impressions,
    reach: existing.reach + row.reach,
    clicks,
    inlineLinkClicks: existing.inlineLinkClicks + row.inlineLinkClicks,
    leads: existing.leads + row.leads,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
  };
}

/**
 * Fetch Meta Insights at the AD level over an inclusive date range (YYYY-MM-DD).
 * Returns one aggregate row per ad and follows Meta pagination.
 */
export async function fetchAdInsights(
  adAccountId: string,
  since: string,
  until: string,
  options?: { campaignIds?: string[] }
): Promise<{ ads: MetaAdInsight[]; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { ads: [], error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = normalizeAdAccountId(adAccountId);
  if (!graphId) {
    return { ads: [], error: "Invalid ad account ID" };
  }

  const params = new URLSearchParams({
    fields:
      "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions",
    level: "ad",
    time_range: JSON.stringify({ since, until }),
    access_token: token,
    limit: "500",
  });

  if (options?.campaignIds?.length) {
    params.set(
      "filtering",
      JSON.stringify([
        {
          field: "campaign.id",
          operator: "IN",
          value: options.campaignIds,
        },
      ])
    );
  }

  let url: string | null = `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${params}`;
  const byAdId = new Map<string, MetaAdInsight>();

  try {
    while (url) {
      const res = await fetch(url);
      const json = (await res.json()) as {
        data?: Array<Record<string, unknown>>;
        paging?: { next?: string };
        error?: { message?: string };
      };

      if (json.error) {
        return { ads: Array.from(byAdId.values()), error: json.error.message ?? "Insights error" };
      }

      const rows = Array.isArray(json.data) ? json.data : [];
      for (const row of rows) {
        const adId = String(row.ad_id ?? "").trim();
        if (!adId) continue;
        const next: MetaAdInsight = {
          adId,
          adName: String(row.ad_name ?? "(Unnamed ad)"),
          adsetId: row.adset_id ? String(row.adset_id) : null,
          adsetName: row.adset_name ? String(row.adset_name) : null,
          campaignId: row.campaign_id ? String(row.campaign_id) : null,
          campaignName: row.campaign_name ? String(row.campaign_name) : null,
          spend: parseNumber(row.spend),
          impressions: parseNumber(row.impressions),
          reach: parseNumber(row.reach),
          frequency: parseNullableNumber(row.frequency),
          clicks: parseNumber(row.clicks),
          inlineLinkClicks: parseNumber(row.inline_link_clicks),
          ctr: parseNullableNumber(row.ctr),
          cpc: parseNullableNumber(row.cpc),
          cpm: parseNullableNumber(row.cpm),
          leads: parseLeadActions(row.actions),
        };
        byAdId.set(adId, mergeAdInsight(byAdId.get(adId), next));
      }

      url = json.paging?.next ?? null;
    }

    return { ads: Array.from(byAdId.values()) };
  } catch (err) {
    return {
      ads: Array.from(byAdId.values()),
      error: err instanceof Error ? err.message : "Failed to fetch ad insights",
    };
  }
}

/**
 * Resolve creative thumbnail URLs for Meta ad IDs. Uses Graph `ids=...` to
 * batch lookups in chunks so the Ads tab does not make one request per row.
 */
export async function fetchAdCreativeThumbnails(
  adIds: string[]
): Promise<{ thumbnailsByAdId: Record<string, string>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { thumbnailsByAdId: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const uniqueAdIds = Array.from(new Set(adIds.map((id) => id.trim()).filter(Boolean)));
  const thumbnailsByAdId: Record<string, string> = {};
  const chunkSize = 50;

  try {
    for (let i = 0; i < uniqueAdIds.length; i += chunkSize) {
      const chunk = uniqueAdIds.slice(i, i + chunkSize);
      const params = new URLSearchParams({
        ids: chunk.join(","),
        fields: "creative{thumbnail_url}",
        access_token: token,
      });
      const url = `${META_GRAPH}/${META_API_VERSION}/?${params}`;
      const res = await fetch(url);
      const json = (await res.json()) as Record<
        string,
        { creative?: { thumbnail_url?: string }; error?: { message?: string } }
      > & { error?: { message?: string } };

      if (json.error) {
        return {
          thumbnailsByAdId,
          error: json.error.message ?? "Creative thumbnail lookup failed",
        };
      }

      for (const adId of chunk) {
        const thumbnail = json[adId]?.creative?.thumbnail_url;
        if (thumbnail) thumbnailsByAdId[adId] = thumbnail;
      }
    }

    return { thumbnailsByAdId };
  } catch (err) {
    return {
      thumbnailsByAdId,
      error: err instanceof Error ? err.message : "Failed to fetch creative thumbnails",
    };
  }
}

/**
 * Spend for each object at the given insights level over an inclusive date range (YYYY-MM-DD).
 * Paginates all results. Optionally restrict to specific campaign IDs (keyword filter flow).
 */
export async function fetchSpendByInsightsLevel(
  adAccountId: string,
  level: MetaInsightsLevel,
  since: string,
  until: string,
  options?: { campaignIds?: string[] }
): Promise<{ spendByObjectId: Record<string, number>; error?: string }> {
  const token = getAccessToken();
  if (!token) {
    return { spendByObjectId: {}, error: "META_ACCESS_TOKEN not configured" };
  }

  const graphId = normalizeAdAccountId(adAccountId);
  if (!graphId) {
    return { spendByObjectId: {}, error: "Invalid ad account ID" };
  }

  const idField =
    level === "campaign"
      ? "campaign_id"
      : level === "adset"
        ? "adset_id"
        : "ad_id";

  const spendByObjectId: Record<string, number> = {};
  let url: string | null =
    `${META_GRAPH}/${META_API_VERSION}/${graphId}/insights?${new URLSearchParams({
      fields: `spend,${idField}`,
      level,
      time_range: JSON.stringify({ since, until }),
      access_token: token,
      limit: "500",
    }).toString()}`;

  if (options?.campaignIds?.length) {
    const u = new URL(url);
    u.searchParams.set(
      "filtering",
      JSON.stringify([
        {
          field: "campaign.id",
          operator: "IN",
          value: options.campaignIds,
        },
      ])
    );
    url = u.toString();
  }

  try {
    while (url) {
      const res = await fetch(url);
      const json = (await res.json()) as {
        data?: Array<Record<string, string | undefined>>;
        paging?: { next?: string };
        error?: { message?: string };
      };

      if (json.error) {
        return {
          spendByObjectId,
          error: json.error.message ?? "Insights error",
        };
      }

      const rows = Array.isArray(json.data) ? json.data : [];
      for (const row of rows) {
        const oid = row[idField];
        const spendVal = row.spend;
        if (oid != null && spendVal != null) {
          const id = String(oid);
          const val = parseFloat(String(spendVal));
          if (!isNaN(val)) {
            spendByObjectId[id] = (spendByObjectId[id] ?? 0) + val;
          }
        }
      }

      url = json.paging?.next ?? null;
    }

    return { spendByObjectId };
  } catch (err) {
    return {
      spendByObjectId: {},
      error: err instanceof Error ? err.message : "Failed to fetch insights",
    };
  }
}
