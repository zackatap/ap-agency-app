import { NextResponse } from "next/server";
import { listActiveCampaigns, type ActiveCampaign } from "@/lib/agency-clients";
import {
  fetchAdCreativeThumbnails,
  fetchAdInsights,
  fetchCampaigns,
  fetchSpendByMonth,
  type FacebookCampaign,
  type MetaAdInsight,
} from "@/lib/facebook-ads";
import {
  DATE_RANGE_LABELS,
  getDateRangeForPreset,
  getMonthsBack,
  type DateRangePreset,
} from "@/lib/date-ranges";
import {
  buildMetaAdRollupSummaries,
  buildMetaAdTagRollupSummaries,
  deriveMetaAdMetrics,
} from "@/lib/meta-ad-rollups";
import {
  getMetaAdsSnapshot,
  listMetaAdTagAssignments,
  listMetaAdTags,
  listMetaAdRollupPhrases,
  upsertMetaAdsSnapshot,
  type MetaAdsCachedRow,
  type MetaAdsSnapshotPayload,
  type MetaAdsWarning,
} from "@/lib/meta-ads-store";

const PRESETS: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

const API_CONCURRENCY = 4;
const RECENT_SPEND_MONTHS = 13;
const META_BUSINESS_ID =
  process.env.META_BUSINESS_ID?.trim() ||
  process.env.FACEBOOK_BUSINESS_ID?.trim() ||
  "1676628412629857";

function isPreset(v: string | null): v is DateRangePreset {
  return !!v && (PRESETS as string[]).includes(v);
}

function ownerName(campaign: ActiveCampaign): string | null {
  const parts = [campaign.ownerFirstName, campaign.ownerLastName].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function adsManagerUrl(adAccountId: string, adId: string): string | null {
  const act = adAccountId.replace(/^act_/, "").trim();
  if (!act || !adId) return null;
  const params = new URLSearchParams({
    act,
    business_id: META_BUSINESS_ID,
    global_scope_id: META_BUSINESS_ID,
    selected_ad_ids: adId,
  });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit/standalone?${params.toString()}`;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await worker(item);
      }
    }
  );
  await Promise.all(workers);
}

function rowFromInsight(args: {
  campaign: ActiveCampaign;
  insight: MetaAdInsight;
  thumbnailUrl: string | null;
}): MetaAdsCachedRow {
  const { campaign, insight, thumbnailUrl } = args;
  const adAccountId = campaign.adAccountId ?? "";
  return {
    rowKey: `${campaign.campaignKey}:${insight.adId}`,
    adId: insight.adId,
    adName: insight.adName,
    adsetId: insight.adsetId,
    adsetName: insight.adsetName,
    campaignId: insight.campaignId,
    campaignName: insight.campaignName,
    thumbnailUrl,
    adsManagerUrl: adsManagerUrl(adAccountId, insight.adId),
    locationId: campaign.locationId,
    campaignKey: campaign.campaignKey,
    cid: campaign.cid,
    businessName: campaign.businessName ?? campaign.locationId,
    ownerName: ownerName(campaign),
    status: campaign.status,
    pipelineKeyword: campaign.pipelineKeyword,
    campaignKeyword: campaign.campaignKeyword,
    adAccountId,
    spend: insight.spend,
    impressions: insight.impressions,
    reach: insight.reach,
    frequency: insight.frequency,
    clicks: insight.clicks,
    inlineLinkClicks: insight.inlineLinkClicks,
    ctr: insight.ctr,
    cpc: insight.cpc,
    cpm: insight.cpm,
    leads: insight.leads,
    cpl: insight.leads > 0 ? insight.spend / insight.leads : null,
  };
}

async function getRecentSpendAccounts(
  adAccountIds: string[],
  clientDate?: string
): Promise<{
  accountsWithSpend: Set<string>;
  warnings: MetaAdsWarning[];
}> {
  const monthKeys = getMonthsBack(RECENT_SPEND_MONTHS, clientDate).map(
    (m) => m.monthKey
  );
  const accountsWithSpend = new Set<string>();
  const warnings: MetaAdsWarning[] = [];

  await runWithConcurrency(adAccountIds, API_CONCURRENCY, async (adAccountId) => {
    const { spendByMonth, error } = await fetchSpendByMonth(
      adAccountId,
      false,
      monthKeys
    );
    if (error) {
      warnings.push({
        adAccountId,
        message: `Recent spend check failed: ${error}`,
      });
      return;
    }
    const total = Object.values(spendByMonth).reduce((sum, n) => sum + n, 0);
    if (total > 0) accountsWithSpend.add(adAccountId);
  });

  return { accountsWithSpend, warnings };
}

function parseRange(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const customFrom = url.searchParams.get("from") ?? undefined;
  const customTo = url.searchParams.get("to") ?? undefined;
  const clientDate = url.searchParams.get("clientDate") ?? undefined;
  const preset: DateRangePreset = isPreset(presetParam) ? presetParam : "last_30";
  const { startDate, endDate } = getDateRangeForPreset(
    preset,
    customFrom,
    customTo,
    clientDate
  );
  return {
    preset,
    startDate,
    endDate,
    label: DATE_RANGE_LABELS[preset],
    clientDate,
  };
}

async function decorateSnapshot(snapshot: MetaAdsSnapshotPayload | null) {
  const [phrases, tags] = await Promise.all([
    listMetaAdRollupPhrases(),
    listMetaAdTags(),
  ]);
  const enabledPhrases = phrases.filter((phrase) => phrase.enabled);
  if (!snapshot) {
    return {
      snapshot: null,
      phrases,
      tags,
      tagAssignments: [],
      rollups: [],
      tagRollups: [],
      rows: [],
      cached: false,
    };
  }
  const tagAssignments = await listMetaAdTagAssignments(
    snapshot.rows.map((row) => row.adId)
  );
  return {
    ...snapshot,
    phrases,
    tags,
    tagAssignments,
    rollups: buildMetaAdRollupSummaries(snapshot.rows, enabledPhrases),
    tagRollups: buildMetaAdTagRollupSummaries(
      snapshot.rows,
      tags,
      tagAssignments
    ),
    cached: true,
  };
}

function sumRows(rows: MetaAdsCachedRow[]) {
  return rows.reduce(
    (acc, row) => ({
      spend: acc.spend + row.spend,
      impressions: acc.impressions + row.impressions,
      reach: acc.reach + row.reach,
      clicks: acc.clicks + row.clicks,
      inlineLinkClicks: acc.inlineLinkClicks + row.inlineLinkClicks,
      leads: acc.leads + row.leads,
    }),
    {
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      inlineLinkClicks: 0,
      leads: 0,
    }
  );
}

export async function GET(req: Request) {
  const range = parseRange(req);
  const snapshot = await getMetaAdsSnapshot({
    startDate: range.startDate,
    endDate: range.endDate,
  });

  return NextResponse.json(await decorateSnapshot(snapshot), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const range = parseRange(req);

  const active = await listActiveCampaigns();
  if (active.error) {
    return NextResponse.json(
      { error: active.error, rows: [], rollups: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const campaignsWithAccounts = active.campaigns.filter(
    (c): c is ActiveCampaign & { adAccountId: string } => !!c.adAccountId
  );
  const uniqueAdAccountIds = Array.from(
    new Set(campaignsWithAccounts.map((c) => c.adAccountId))
  );
  const { accountsWithSpend, warnings } = await getRecentSpendAccounts(
    uniqueAdAccountIds,
    range.clientDate
  );
  const eligibleCampaigns = campaignsWithAccounts.filter((c) =>
    accountsWithSpend.has(c.adAccountId)
  );

  const campaignCache = new Map<
    string,
    Promise<{ campaigns: FacebookCampaign[]; error?: string }>
  >();
  const getFbCampaigns = (adAccountId: string) => {
    let promise = campaignCache.get(adAccountId);
    if (!promise) {
      promise = fetchCampaigns(adAccountId);
      campaignCache.set(adAccountId, promise);
    }
    return promise;
  };

  const insights: Array<{ campaign: ActiveCampaign; insight: MetaAdInsight }> = [];
  await runWithConcurrency(eligibleCampaigns, API_CONCURRENCY, async (campaign) => {
    let campaignIds: string[] | undefined;
    const keyword = campaign.campaignKeyword?.trim();

    if (keyword) {
      const { campaigns, error } = await getFbCampaigns(campaign.adAccountId);
      if (error) {
        warnings.push({
          adAccountId: campaign.adAccountId,
          campaignKey: campaign.campaignKey,
          message: `Campaign keyword lookup failed: ${error}`,
        });
        return;
      }
      const kwLower = keyword.toLowerCase();
      campaignIds = campaigns
        .filter((fb) => fb.name.toLowerCase().includes(kwLower))
        .map((fb) => fb.id);
      if (campaignIds.length === 0) {
        warnings.push({
          adAccountId: campaign.adAccountId,
          campaignKey: campaign.campaignKey,
          message: `No Meta campaign name contains "${keyword}".`,
        });
        return;
      }
    }

    const { ads, error } = await fetchAdInsights(
      campaign.adAccountId,
      range.startDate,
      range.endDate,
      campaignIds ? { campaignIds } : undefined
    );
    if (error) {
      warnings.push({
        adAccountId: campaign.adAccountId,
        campaignKey: campaign.campaignKey,
        message: `Ad insights failed: ${error}`,
      });
    }
    for (const insight of ads) {
      if (insight.spend <= 0 && insight.impressions <= 0) continue;
      insights.push({ campaign, insight });
    }
  });

  const { thumbnailsByAdId, error: thumbnailError } =
    await fetchAdCreativeThumbnails(insights.map((r) => r.insight.adId));
  if (thumbnailError) {
    warnings.push({ message: `Thumbnail lookup failed: ${thumbnailError}` });
  }

  const rows = insights
    .map(({ campaign, insight }) =>
      rowFromInsight({
        campaign,
        insight,
        thumbnailUrl: thumbnailsByAdId[insight.adId] ?? null,
      })
    )
    .sort((a, b) => b.spend - a.spend);

  const snapshot = await upsertMetaAdsSnapshot({
    range: {
      preset: range.preset,
      startDate: range.startDate,
      endDate: range.endDate,
      label: range.label,
    },
    recentSpendMonths: RECENT_SPEND_MONTHS,
    accountCount: uniqueAdAccountIds.length,
    eligibleAccountCount: accountsWithSpend.size,
    sheetCampaignCount: active.campaigns.length,
    eligibleCampaignCount: eligibleCampaigns.length,
    rowCount: rows.length,
    totals: deriveMetaAdMetrics(sumRows(rows)),
    rows,
    warnings,
  });

  return NextResponse.json(await decorateSnapshot(snapshot), {
    headers: { "Cache-Control": "no-store" },
  });
}
