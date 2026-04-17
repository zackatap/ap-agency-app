/**
 * Runs a rollup refresh: enumerates active campaigns, resolves each to a GHL
 * pipeline using the hybrid rule below, fetches 13 months of funnel data +
 * Meta ad spend per campaign, and persists the results to agency_rollup_*.
 *
 * Unit of work: a CAMPAIGN (= one row in the Client Database sheet). A single
 * GHL location with ACTIVE + 2ND CMPN rows contributes two separate campaigns,
 * potentially on two different pipelines.
 *
 * Pipeline resolution (hybrid):
 *   1. If column I (PIPELINE KEYWORD) is set AND exactly one GHL pipeline
 *      name contains that substring (case-insensitive) → use it.
 *   2. Else if the location has exactly one pipeline → use it.
 *   3. Else → flag the campaign as "needs setup" with a specific reason.
 *
 * Meta spend (per campaign):
 *   Uses the campaign's ad account + column J (CAMPAIGN KEYWORD) to filter
 *   Meta campaigns, then sums spend across matches. Matches the behavior of
 *   the per-location dashboard's insights endpoint. The FB campaign list is
 *   cached per ad-account so ACTIVE + 2ND CMPN sharing an account don't
 *   trigger duplicate fetches.
 *
 * Concurrency is capped at ROLLUP_CONCURRENCY locations in flight (not
 * campaigns — this keeps the shared GHL/Meta fetches per location coherent).
 * Each per-location failure is captured and does not abort the run.
 */

import { getToken } from "@/lib/oauth-tokens";
import {
  getPipelines,
  getOpportunityCountsByStagePerMonth,
  type GHLPipeline,
} from "@/lib/ghl-oauth";
import { calculateFunnelMetrics, type FunnelMetrics } from "@/lib/funnel-metrics";
import { getMonthsBack } from "@/lib/date-ranges";
import { getLocationSettings } from "@/lib/location-settings";
import {
  fetchCampaigns,
  fetchSpendByMonth,
  type FacebookCampaign,
} from "@/lib/facebook-ads";
import {
  listActiveCampaigns,
  type ActiveCampaign,
} from "@/lib/agency-clients";
import {
  createSnapshot,
  finishSnapshot,
  insertCampaignMonths,
  updateSnapshotProgress,
  upsertCampaigns,
  getRunningSnapshot,
  expireStaleRunningSnapshots,
  type AgencyCampaignMonth,
  type AgencySnapshot,
} from "@/lib/agency-rollup-store";

const ROLLUP_CONCURRENCY = 6;
const DEFAULT_MONTHS = 13;

export interface StartRollupParams {
  monthsCovered?: number;
  triggeredBy?: "manual" | "cron";
  skipIfRunning?: boolean;
  /** Process at most this many campaigns. Useful for testing/debugging. */
  limit?: number;
  /**
   * Optional hook for `after()` / `waitUntil()` so serverless platforms keep
   * the function alive until the background work finishes. Vercel kills
   * dangling promises the moment the response returns otherwise.
   */
  waitUntil?: (promise: Promise<void>) => void;
}

export interface StartRollupResult {
  status: "started" | "already-running" | "error";
  snapshotId?: number;
  message?: string;
}

type SnapshotError = AgencySnapshot["errors"][number];

export async function startRollupRefresh(
  params: StartRollupParams = {}
): Promise<StartRollupResult> {
  const months = params.monthsCovered ?? DEFAULT_MONTHS;
  const trigger = params.triggeredBy ?? "manual";

  await expireStaleRunningSnapshots();

  if (params.skipIfRunning) {
    const running = await getRunningSnapshot();
    if (running) {
      return {
        status: "already-running",
        snapshotId: running.id,
        message: "A rollup refresh is already in progress.",
      };
    }
  }

  const snapshot = await createSnapshot({
    monthsCovered: months,
    triggeredBy: trigger,
  });
  if (!snapshot) {
    return {
      status: "error",
      message: "DATABASE_URL not configured — cannot create snapshot.",
    };
  }

  const runPromise = executeRollup(snapshot.id, months, params.limit).catch(
    (err) => {
      console.error("[agency-rollup-runner] execute failed:", err);
    }
  );

  if (params.waitUntil) {
    params.waitUntil(runPromise);
  } else {
    void runPromise;
  }

  return { status: "started", snapshotId: snapshot.id };
}

async function executeRollup(
  snapshotId: number,
  months: number,
  limit?: number
): Promise<void> {
  const errors: SnapshotError[] = [];

  await updateSnapshotProgress(snapshotId, {
    progressLabel: "Loading client roster",
  });

  const { campaigns: allCampaigns, error: sheetError } =
    await listActiveCampaigns();
  if (sheetError) {
    errors.push({ message: `Sheet load failed: ${sheetError}` });
  }

  const campaigns = limit ? allCampaigns.slice(0, limit) : allCampaigns;
  if (limit && allCampaigns.length > limit) {
    console.info(
      `[agency-rollup-runner] limit=${limit} applied (of ${allCampaigns.length} campaigns).`
    );
  }

  if (campaigns.length === 0) {
    await finishSnapshot(snapshotId, {
      status: "failed",
      clientsIncluded: 0,
      clientsFailed: 0,
      errors: [
        ...errors,
        { message: "No active campaigns found in Client Database." },
      ],
    });
    return;
  }

  const monthRanges = getMonthsBack(months);

  // Group campaigns by locationId so we can share GHL work (one token lookup
  // + one pipeline list fetch per location instead of per campaign).
  const byLocation = new Map<string, ActiveCampaign[]>();
  for (const c of campaigns) {
    const list = byLocation.get(c.locationId) ?? [];
    list.push(c);
    byLocation.set(c.locationId, list);
  }
  const locationGroups = Array.from(byLocation.values());

  await updateSnapshotProgress(snapshotId, {
    clientsTotal: campaigns.length,
    progressTotal: campaigns.length,
    progressCurrent: 0,
    progressLabel: `Fetching data for ${campaigns.length} campaigns across ${locationGroups.length} locations`,
  });

  let completed = 0;
  let included = 0;
  let failed = 0;

  // Shared cache of FB campaign lists. An ad account shared by two sheet rows
  // (e.g. ACTIVE + 2ND CMPN in the same account) only gets listed once.
  const fbCampaignCache = new Map<
    string,
    Promise<{ campaigns: FacebookCampaign[]; error?: string }>
  >();
  const getFbCampaigns = (adAccountId: string) => {
    let promise = fbCampaignCache.get(adAccountId);
    if (!promise) {
      promise = fetchCampaigns(adAccountId);
      fbCampaignCache.set(adAccountId, promise);
    }
    return promise;
  };

  await runWithConcurrency(
    locationGroups,
    ROLLUP_CONCURRENCY,
    async (campaignsAtLocation) => {
      const locationId = campaignsAtLocation[0].locationId;
      try {
        await processLocation({
          snapshotId,
          locationId,
          campaignsAtLocation,
          monthRanges,
          getFbCampaigns,
          onCampaignResult: (result) => {
            if (result === "ok") included += 1;
            else failed += 1;
            if (result === "failed-with-error") {
              // errors already pushed by processLocation
            }
          },
          pushError: (e) => errors.push(e),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const campaign of campaignsAtLocation) {
          failed += 1;
          errors.push({
            campaignKey: campaign.campaignKey,
            locationId: campaign.locationId,
            businessName: campaign.businessName ?? undefined,
            message,
          });
          try {
            await upsertCampaignWithoutPipeline(campaign, message);
            await insertEmptyMonthRows(
              snapshotId,
              campaign,
              monthRanges,
              message,
              "error"
            );
          } catch (inner) {
            console.error(
              "[agency-rollup-runner] recovery insert failed:",
              inner
            );
          }
        }
      } finally {
        completed += campaignsAtLocation.length;
        if (completed % 3 === 0 || completed >= campaigns.length) {
          await updateSnapshotProgress(snapshotId, {
            progressCurrent: Math.min(completed, campaigns.length),
            clientsIncluded: included,
            clientsFailed: failed,
            progressLabel: `${Math.min(completed, campaigns.length)} / ${campaigns.length} campaigns`,
          });
        }
      }
    }
  );

  await finishSnapshot(snapshotId, {
    status: "complete",
    clientsIncluded: included,
    clientsFailed: failed,
    errors,
  });
}

/**
 * Process every campaign that belongs to a single GHL location. We fetch the
 * location's OAuth token and pipeline list exactly once, then resolve each
 * campaign individually and fetch its opportunity counts + Meta spend.
 */
async function processLocation(args: {
  snapshotId: number;
  locationId: string;
  campaignsAtLocation: ActiveCampaign[];
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>;
  getFbCampaigns: (
    adAccountId: string
  ) => Promise<{ campaigns: FacebookCampaign[]; error?: string }>;
  onCampaignResult: (result: "ok" | "skipped" | "failed-with-error") => void;
  pushError: (e: SnapshotError) => void;
}): Promise<void> {
  const {
    snapshotId,
    locationId,
    campaignsAtLocation,
    monthRanges,
    getFbCampaigns,
    onCampaignResult,
    pushError,
  } = args;

  const stored = await getToken(locationId);
  if (!stored) {
    const reason = "No OAuth token — app not installed for this location.";
    for (const c of campaignsAtLocation) {
      await upsertCampaignWithoutPipeline(c, reason);
      await insertEmptyMonthRows(
        snapshotId,
        c,
        monthRanges,
        reason,
        "skipped"
      );
      onCampaignResult("skipped");
      pushError({
        campaignKey: c.campaignKey,
        locationId: c.locationId,
        businessName: c.businessName ?? undefined,
        message: reason,
      });
    }
    return;
  }

  const [pipelines, settings] = await Promise.all([
    getPipelines(locationId, stored.access_token),
    getLocationSettings(locationId),
  ]);

  // Cache opportunity counts per pipeline: two campaigns pointing at the same
  // pipeline (uncommon but possible) only fetch once.
  const oppCountsCache = new Map<
    string,
    Promise<
      Awaited<ReturnType<typeof getOpportunityCountsByStagePerMonth>>
    >
  >();

  for (const campaign of campaignsAtLocation) {
    const resolution = resolvePipeline(campaign, pipelines);
    if (!resolution.pipeline) {
      await upsertCampaignWithoutPipeline(campaign, resolution.reason);
      await insertEmptyMonthRows(
        snapshotId,
        campaign,
        monthRanges,
        resolution.reason,
        "skipped"
      );
      onCampaignResult("skipped");
      pushError({
        campaignKey: campaign.campaignKey,
        locationId: campaign.locationId,
        businessName: campaign.businessName ?? undefined,
        message: resolution.reason,
      });
      continue;
    }

    const pipeline = resolution.pipeline;
    const attributionMode = settings?.attributionMode ?? "lastUpdated";
    const customMappings = settings?.stageMappings?.[pipeline.id];

    let oppFetch = oppCountsCache.get(pipeline.id);
    if (!oppFetch) {
      oppFetch = getOpportunityCountsByStagePerMonth(
        locationId,
        pipeline,
        stored.access_token,
        monthRanges,
        attributionMode
      );
      oppCountsCache.set(pipeline.id, oppFetch);
    }
    const perMonth = await oppFetch;

    const monthKeys = monthRanges.map((m) => m.monthKey);
    const configuredAdSpend = settings?.adSpend?.[pipeline.id] ?? {};

    const fbSpend = await resolveCampaignSpend({
      campaign,
      monthKeys,
      getFbCampaigns,
    });

    const monthRows = perMonth.map((m) => {
      const metrics = calculateFunnelMetrics(
        m.counts,
        m.values,
        pipeline.stages ?? undefined,
        customMappings
      );
      const manualSpend = Number(configuredAdSpend[m.monthKey] ?? 0);
      const apiSpend = Number(fbSpend[m.monthKey] ?? 0);
      const adSpend = manualSpend > 0 ? manualSpend : apiSpend;
      return {
        monthKey: m.monthKey,
        startDate: m.startDate,
        endDate: m.endDate,
        metrics,
        adSpend,
      };
    });

    await upsertCampaigns([
      {
        campaignKey: campaign.campaignKey,
        locationId: campaign.locationId,
        status: campaign.status,
        cid: campaign.cid,
        businessName: campaign.businessName,
        ownerFirstName: campaign.ownerFirstName,
        ownerLastName: campaign.ownerLastName,
        pipelineKeyword: campaign.pipelineKeyword,
        campaignKeyword: campaign.campaignKeyword,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        adAccountId: campaign.adAccountId,
        needsSetupReason: null,
      },
    ]);

    await insertCampaignMonths(
      monthRows.map<AgencyCampaignMonth>((row) => ({
        snapshotId,
        campaignKey: campaign.campaignKey,
        locationId: campaign.locationId,
        monthKey: row.monthKey,
        startDate: row.startDate,
        endDate: row.endDate,
        metrics: row.metrics,
        adSpend: row.adSpend,
        status: "ok",
        errorMessage: null,
      }))
    );

    onCampaignResult("ok");
  }
}

interface PipelineResolution {
  pipeline: GHLPipeline | null;
  reason: string;
}

function resolvePipeline(
  campaign: ActiveCampaign,
  pipelines: GHLPipeline[]
): PipelineResolution {
  if (pipelines.length === 0) {
    return {
      pipeline: null,
      reason: "GHL returned no pipelines for this location.",
    };
  }

  const keyword = campaign.pipelineKeyword?.trim();
  if (keyword) {
    const kw = keyword.toLowerCase();
    const matches = pipelines.filter((p) =>
      (p.name ?? "").toLowerCase().includes(kw)
    );
    if (matches.length === 1) {
      return { pipeline: matches[0], reason: "" };
    }
    if (matches.length > 1) {
      return {
        pipeline: null,
        reason: `Column I "${keyword}" matched ${matches.length} pipelines: ${matches
          .map((p) => p.name)
          .join(", ")}. Make the keyword more specific.`,
      };
    }
    // no match with keyword — fall through to single-pipeline fallback
  }

  if (pipelines.length === 1) {
    return { pipeline: pipelines[0], reason: "" };
  }

  const available = pipelines.map((p) => p.name).join(", ");
  return {
    pipeline: null,
    reason: keyword
      ? `No GHL pipeline name contains "${keyword}". Available: ${available}.`
      : `Location has ${pipelines.length} pipelines and column I is empty. Available: ${available}.`,
  };
}

async function resolveCampaignSpend(args: {
  campaign: ActiveCampaign;
  monthKeys: string[];
  getFbCampaigns: (
    adAccountId: string
  ) => Promise<{ campaigns: FacebookCampaign[]; error?: string }>;
}): Promise<Record<string, number>> {
  const { campaign, monthKeys, getFbCampaigns } = args;
  if (!campaign.adAccountId) return {};

  const keyword = campaign.campaignKeyword?.trim();

  // No keyword → account-level total (matches old behavior and the per-location
  // dashboard's "all campaigns" mode).
  if (!keyword) {
    try {
      const { spendByMonth } = await fetchSpendByMonth(
        campaign.adAccountId,
        false,
        monthKeys
      );
      return spendByMonth;
    } catch (err) {
      console.warn(
        `[agency-rollup-runner] account-level spend failed for ${campaign.locationId}:`,
        err
      );
      return {};
    }
  }

  // Keyword filter: list FB campaigns (cached per ad account), match by name,
  // aggregate monthly spend across matches.
  const { campaigns: fbCampaigns, error } = await getFbCampaigns(
    campaign.adAccountId
  );
  if (error || fbCampaigns.length === 0) {
    if (error) {
      console.warn(
        `[agency-rollup-runner] FB campaign list failed for ${campaign.adAccountId}:`,
        error
      );
    }
    return {};
  }
  const kwLower = keyword.toLowerCase();
  const matches = fbCampaigns.filter((c) =>
    (c.name ?? "").toLowerCase().includes(kwLower)
  );
  if (matches.length === 0) {
    return Object.fromEntries(monthKeys.map((k) => [k, 0]));
  }

  const aggregated: Record<string, number> = Object.fromEntries(
    monthKeys.map((k) => [k, 0])
  );
  for (const fb of matches) {
    try {
      const { spendByMonth, error: spendErr } = await fetchSpendByMonth(
        fb.id,
        true,
        monthKeys
      );
      if (spendErr) continue;
      for (const [mk, amount] of Object.entries(spendByMonth)) {
        aggregated[mk] = (aggregated[mk] ?? 0) + amount;
      }
    } catch (err) {
      console.warn(
        `[agency-rollup-runner] spend failed for FB campaign ${fb.id}:`,
        err
      );
    }
  }
  return aggregated;
}

async function upsertCampaignWithoutPipeline(
  campaign: ActiveCampaign,
  reason: string
): Promise<void> {
  await upsertCampaigns([
    {
      campaignKey: campaign.campaignKey,
      locationId: campaign.locationId,
      status: campaign.status,
      cid: campaign.cid,
      businessName: campaign.businessName,
      ownerFirstName: campaign.ownerFirstName,
      ownerLastName: campaign.ownerLastName,
      pipelineKeyword: campaign.pipelineKeyword,
      campaignKeyword: campaign.campaignKeyword,
      pipelineId: null,
      pipelineName: null,
      adAccountId: campaign.adAccountId,
      needsSetupReason: reason,
    },
  ]);
}

async function insertEmptyMonthRows(
  snapshotId: number,
  campaign: ActiveCampaign,
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>,
  reason: string,
  status: "skipped" | "error"
): Promise<void> {
  await insertCampaignMonths(
    monthRanges.map<AgencyCampaignMonth>((range) => ({
      snapshotId,
      campaignKey: campaign.campaignKey,
      locationId: campaign.locationId,
      monthKey: range.monthKey,
      startDate: range.startDate,
      endDate: range.endDate,
      metrics: emptyMetrics(),
      adSpend: 0,
      status,
      errorMessage: reason,
    }))
  );
}

function emptyMetrics(): FunnelMetrics {
  return {
    leads: 0,
    requested: 0,
    confirmed: 0,
    totalAppts: 0,
    showed: 0,
    noShow: 0,
    success: 0,
    closed: 0,
    total: 0,
    totalApptsRaw: 0,
    bookingRate: null,
    confirmationRate: null,
    showRate: null,
    showedConversionRate: null,
    totalValue: 0,
    showedValue: 0,
    successValue: 0,
    requestedValue: 0,
    confirmedValue: 0,
  };
}

/** Minimal concurrency helper — keeps at most `concurrency` tasks in flight. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  const runners = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < runners; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) return;
          await worker(next);
        }
      })()
    );
  }
  await Promise.all(workers);
}
