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

export type MetaInsightsLevel = "campaign" | "adset" | "ad";

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
