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
  addMetaAdTotals,
  buildMetaAdRollupSummaries,
  buildMetaAdTagRollupSummaries,
  deriveMetaAdMetrics,
} from "@/lib/meta-ad-rollups";
import {
  getLatestMetaAdsSnapshotForPreset,
  getMetaAdsSnapshot,
  listMetaAdsDailySnapshots,
  listMetaAdTagAssignments,
  listMetaAdTagRollups,
  listMetaAdTags,
  listMetaAdRollupPhrases,
  upsertMetaAdsDailySnapshot,
  upsertMetaAdsSnapshot,
  type MetaAdsDailySnapshot,
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

interface CacheCoverage {
  startDate: string | null;
  endDate: string | null;
  requestedStartDate: string;
  requestedEndDate: string;
  missingDates: string[];
  source: "daily" | "snapshot" | "mixed" | "none";
}

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

function enumerateDates(startDate: string, endDate: string): string[] {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const current = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const dates: string[] = [];
  while (current <= end) {
    dates.push(
      `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`
    );
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
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

async function decorateSnapshot(
  snapshot: MetaAdsSnapshotPayload | null,
  coverage?: CacheCoverage
) {
  const [phrases, tags, tagRollupRules] = await Promise.all([
    listMetaAdRollupPhrases(),
    listMetaAdTags(),
    listMetaAdTagRollups(),
  ]);
  const enabledPhrases = phrases.filter((phrase) => phrase.enabled);
  if (!snapshot) {
    return {
      snapshot: null,
      phrases,
      tags,
      tagRollupRules,
      tagAssignments: [],
      rollups: [],
      tagRollups: [],
      rows: [],
      cached: false,
      cacheCoverage: coverage,
    };
  }
  const tagAssignments = await listMetaAdTagAssignments(
    snapshot.rows.map((row) => row.adId)
  );
  return {
    ...snapshot,
    phrases,
    tags,
    tagRollupRules,
    tagAssignments,
    rollups: buildMetaAdRollupSummaries(snapshot.rows, enabledPhrases),
    tagRollups: buildMetaAdTagRollupSummaries(
      snapshot.rows,
      tagRollupRules.filter((rule) => rule.enabled),
      tagAssignments
    ),
    cached: true,
    cacheCoverage: coverage,
  };
}

function aggregateRows(rows: MetaAdsCachedRow[]): MetaAdsCachedRow[] {
  const byKey = new Map<string, MetaAdsCachedRow>();
  for (const row of rows) {
    const key = row.rowKey || `${row.campaignKey}:${row.adId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }
    const totals = addMetaAdTotals(existing, row);
    byKey.set(key, {
      ...existing,
      ...row,
      ...deriveMetaAdMetrics(totals),
      cpl: totals.leads > 0 ? totals.spend / totals.leads : null,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => b.spend - a.spend);
}

function aggregateDailySnapshots(args: {
  range: ReturnType<typeof parseRange>;
  dailySnapshots: MetaAdsDailySnapshot[];
  fallbackSnapshot?: MetaAdsSnapshotPayload | null;
}): { snapshot: MetaAdsSnapshotPayload | null; coverage: CacheCoverage } {
  const requestedDates = enumerateDates(args.range.startDate, args.range.endDate);
  const dailyByDate = new Map(args.dailySnapshots.map((snapshot) => [snapshot.dateKey, snapshot]));
  const fallbackCoversDate = (date: string) =>
    Boolean(
      args.fallbackSnapshot &&
        date >= args.fallbackSnapshot.range.startDate &&
        date <= args.fallbackSnapshot.range.endDate
    );
  const missingDates = requestedDates.filter(
    (date) => !dailyByDate.has(date) && !fallbackCoversDate(date)
  );
  const usableDailySnapshots = args.fallbackSnapshot
    ? args.dailySnapshots.filter(
        (snapshot) => snapshot.dateKey > args.fallbackSnapshot!.range.endDate
      )
    : args.dailySnapshots;
  const dailyDates = usableDailySnapshots.map((snapshot) => snapshot.dateKey).sort();
  const dailyRows = aggregateRows(usableDailySnapshots.flatMap((snapshot) => snapshot.rows));
  const dailyWarnings = usableDailySnapshots.flatMap((snapshot) => snapshot.warnings);

  if (dailyRows.length > 0) {
    const rows = aggregateRows([
      ...(args.fallbackSnapshot?.rows ?? []),
      ...dailyRows,
    ]);
    const startDate = args.fallbackSnapshot?.range.startDate ?? dailyDates[0];
    const endDate = dailyDates[dailyDates.length - 1];
    const snapshot: MetaAdsSnapshotPayload = {
      range: {
        preset: args.range.preset,
        startDate,
        endDate,
        label: args.range.label,
      },
      recentSpendMonths: RECENT_SPEND_MONTHS,
      accountCount: Math.max(
        args.fallbackSnapshot?.accountCount ?? 0,
        ...args.dailySnapshots.map((s) => s.accountCount),
        0
      ),
      eligibleAccountCount: Math.max(
        args.fallbackSnapshot?.eligibleAccountCount ?? 0,
        ...args.dailySnapshots.map((s) => s.eligibleAccountCount),
        0
      ),
      sheetCampaignCount: Math.max(
        args.fallbackSnapshot?.sheetCampaignCount ?? 0,
        ...args.dailySnapshots.map((s) => s.sheetCampaignCount),
        0
      ),
      eligibleCampaignCount: Math.max(
        args.fallbackSnapshot?.eligibleCampaignCount ?? 0,
        ...args.dailySnapshots.map((s) => s.eligibleCampaignCount),
        0
      ),
      rowCount: rows.length,
      totals: deriveMetaAdMetrics(sumRows(rows)),
      rows,
      warnings: [...(args.fallbackSnapshot?.warnings ?? []), ...dailyWarnings],
    };
    return {
      snapshot,
      coverage: {
        startDate: snapshot.range.startDate,
        endDate: snapshot.range.endDate,
        requestedStartDate: args.range.startDate,
        requestedEndDate: args.range.endDate,
        missingDates,
        source: args.fallbackSnapshot ? "mixed" : "daily",
      },
    };
  }

  if (args.fallbackSnapshot) {
    return {
      snapshot: args.fallbackSnapshot,
      coverage: {
        startDate: args.fallbackSnapshot.range.startDate,
        endDate: args.fallbackSnapshot.range.endDate,
        requestedStartDate: args.range.startDate,
        requestedEndDate: args.range.endDate,
        missingDates: enumerateDates(
          nextDate(args.fallbackSnapshot.range.endDate),
          args.range.endDate
        ),
        source: "snapshot",
      },
    };
  }

  return {
    snapshot: null,
    coverage: {
      startDate: null,
      endDate: null,
      requestedStartDate: args.range.startDate,
      requestedEndDate: args.range.endDate,
      missingDates: requestedDates,
      source: "none",
    },
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

async function buildMetaAdsRowsForRange(args: {
  startDate: string;
  endDate: string;
  clientDate?: string;
  seedAdAccountIds?: Set<string>;
}): Promise<{
  snapshotBase: Omit<MetaAdsSnapshotPayload, "range" | "totals">;
  rows: MetaAdsCachedRow[];
}> {
  const active = await listActiveCampaigns();
  if (active.error) {
    throw new Error(active.error);
  }

  const campaignsWithAccounts = active.campaigns.filter(
    (c): c is ActiveCampaign & { adAccountId: string } => !!c.adAccountId
  );
  const uniqueAdAccountIds = Array.from(
    new Set(campaignsWithAccounts.map((c) => c.adAccountId))
  );
  let warnings: MetaAdsWarning[] = [];
  let eligibleCampaigns: Array<ActiveCampaign & { adAccountId: string }>;
  let eligibleAccountCount = 0;

  if (args.seedAdAccountIds?.size) {
    eligibleCampaigns = campaignsWithAccounts.filter((c) =>
      args.seedAdAccountIds?.has(c.adAccountId)
    );
    eligibleAccountCount = args.seedAdAccountIds.size;
  } else {
    const recentSpend = await getRecentSpendAccounts(
      uniqueAdAccountIds,
      args.clientDate
    );
    warnings = recentSpend.warnings;
    eligibleAccountCount = recentSpend.accountsWithSpend.size;
    eligibleCampaigns = campaignsWithAccounts.filter((c) =>
      recentSpend.accountsWithSpend.has(c.adAccountId)
    );
  }

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
      args.startDate,
      args.endDate,
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

  return {
    snapshotBase: {
      recentSpendMonths: RECENT_SPEND_MONTHS,
      accountCount: uniqueAdAccountIds.length,
      eligibleAccountCount,
      sheetCampaignCount: active.campaigns.length,
      eligibleCampaignCount: eligibleCampaigns.length,
      rowCount: rows.length,
      rows,
      warnings,
    },
    rows,
  };
}

export async function GET(req: Request) {
  const range = parseRange(req);
  const exactSnapshot = await getMetaAdsSnapshot({
    startDate: range.startDate,
    endDate: range.endDate,
  });
  if (exactSnapshot) {
    return NextResponse.json(
      await decorateSnapshot(exactSnapshot, {
        startDate: exactSnapshot.range.startDate,
        endDate: exactSnapshot.range.endDate,
        requestedStartDate: range.startDate,
        requestedEndDate: range.endDate,
        missingDates: [],
        source: "snapshot",
      }),
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const [dailySnapshots, latestPresetSnapshot] = await Promise.all([
    listMetaAdsDailySnapshots({
      startDate: range.startDate,
      endDate: range.endDate,
    }),
    getLatestMetaAdsSnapshotForPreset(range.preset),
  ]);
  const { snapshot, coverage } = aggregateDailySnapshots({
    range,
    dailySnapshots,
    fallbackSnapshot: latestPresetSnapshot,
  });

  return NextResponse.json(await decorateSnapshot(snapshot, coverage), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const range = parseRange(req);
  const existingDaily = await listMetaAdsDailySnapshots({
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const cachedDates = new Set(existingDaily.map((snapshot) => snapshot.dateKey));
  const requestedDates = enumerateDates(range.startDate, range.endDate);
  let missingDates = requestedDates.filter((date) => !cachedDates.has(date));
  const latestPresetSnapshot = await getLatestMetaAdsSnapshotForPreset(range.preset);

  if (existingDaily.length === 0 && !latestPresetSnapshot) {
    try {
      const { snapshotBase, rows } = await buildMetaAdsRowsForRange({
        startDate: range.startDate,
        endDate: range.endDate,
        clientDate: range.clientDate,
      });
      const snapshot = await upsertMetaAdsSnapshot({
        range: {
          preset: range.preset,
          startDate: range.startDate,
          endDate: range.endDate,
          label: range.label,
        },
        recentSpendMonths: snapshotBase.recentSpendMonths,
        accountCount: snapshotBase.accountCount,
        eligibleAccountCount: snapshotBase.eligibleAccountCount,
        sheetCampaignCount: snapshotBase.sheetCampaignCount,
        eligibleCampaignCount: snapshotBase.eligibleCampaignCount,
        rowCount: rows.length,
        totals: deriveMetaAdMetrics(sumRows(rows)),
        rows,
        warnings: snapshotBase.warnings,
      });

      return NextResponse.json(
        await decorateSnapshot(snapshot, {
          startDate: range.startDate,
          endDate: range.endDate,
          requestedStartDate: range.startDate,
          requestedEndDate: range.endDate,
          missingDates: [],
          source: "snapshot",
        }),
        {
          headers: { "Cache-Control": "no-store" },
        }
      );
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to refresh Meta ads" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  if (existingDaily.length === 0 && latestPresetSnapshot) {
    missingDates = enumerateDates(
      nextDate(latestPresetSnapshot.range.endDate),
      range.endDate
    );
  }

  try {
    const seedAdAccountIds = latestPresetSnapshot
      ? new Set(latestPresetSnapshot.rows.map((row) => row.adAccountId).filter(Boolean))
      : undefined;
    await runWithConcurrency(missingDates, 1, async (dateKey) => {
      const { snapshotBase } = await buildMetaAdsRowsForRange({
        startDate: dateKey,
        endDate: dateKey,
        clientDate: range.clientDate,
        seedAdAccountIds,
      });
      await upsertMetaAdsDailySnapshot({
        dateKey,
        recentSpendMonths: snapshotBase.recentSpendMonths,
        accountCount: snapshotBase.accountCount,
        eligibleAccountCount: snapshotBase.eligibleAccountCount,
        sheetCampaignCount: snapshotBase.sheetCampaignCount,
        eligibleCampaignCount: snapshotBase.eligibleCampaignCount,
        rows: snapshotBase.rows,
        warnings: snapshotBase.warnings,
      });
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to refresh Meta ads" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const dailySnapshots = await listMetaAdsDailySnapshots({
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const { snapshot, coverage } = aggregateDailySnapshots({
    range,
    dailySnapshots,
    fallbackSnapshot: latestPresetSnapshot,
  });

  if (snapshot) {
    await upsertMetaAdsSnapshot({
      ...snapshot,
      range: {
        preset: range.preset,
        startDate: snapshot.range.startDate,
        endDate: snapshot.range.endDate,
        label: range.label,
      },
    });
  }

  return NextResponse.json(await decorateSnapshot(snapshot, coverage), {
    headers: { "Cache-Control": "no-store" },
  });
}
