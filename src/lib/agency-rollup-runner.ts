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
  getOpportunityCountsByStagePerDay,
  type GHLOpportunity,
  type GHLPipeline,
} from "@/lib/ghl-oauth";
import {
  calculateFunnelMetrics,
  getEffectiveMapping,
  type FunnelMetrics,
} from "@/lib/funnel-metrics";
import { getMonthsBack } from "@/lib/date-ranges";
import { getLocationSettings } from "@/lib/location-settings";
import {
  fetchCampaigns,
  fetchSpendByDay,
  type FacebookCampaign,
} from "@/lib/facebook-ads";
import {
  listActiveCampaigns,
  type ActiveCampaign,
} from "@/lib/agency-clients";
import {
  createSnapshot,
  finishSnapshot,
  insertCampaignDays,
  updateSnapshotProgress,
  upsertCampaigns,
  upsertCampaignRuns,
  getRunningSnapshot,
  expireStaleRunningSnapshots,
  type AgencyCampaignDay,
  type AgencySnapshot,
} from "@/lib/agency-rollup-store";

const ROLLUP_CONCURRENCY = 6;
const DEFAULT_MONTHS = 13;

/**
 * Data-hygiene thresholds.
 *
 * STALE_OPEN_DAYS: an opportunity that is currently "open" in a Requested or
 * Confirmed (automated) stage but hasn't had its stage touched in this many
 * days is almost certainly left behind by a client who isn't working the
 * board anymore.
 *
 * MOVEMENT_GRACE_DAYS: exclude any month whose endDate is within this many
 * days of "now" when computing movement ratio — recent appointments
 * legitimately haven't been marked showed/no-show yet and shouldn't count
 * against the client.
 */
const STALE_OPEN_DAYS = 21;
const MOVEMENT_GRACE_DAYS = 14;

interface CampaignQualitySignals {
  movementRatio: number | null;
  openCount: number | null;
  staleOpenCount: number | null;
  staleOpenPct: number | null;
  lastManualStageChangeAt: string | null;
}

const OPEN_AUTO_STAGES = new Set(["requested", "confirmed", "lead"]);
const MANUAL_STAGES = new Set(["showed", "noShow", "closed"]);

function parseIsoTimestamp(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function extractLastStageChange(opp: GHLOpportunity): number | null {
  const record = opp as Record<string, unknown>;
  const candidates = [
    opp.lastStageChangeAt,
    record.last_stage_change_at,
    opp.lastStatusChangeAt,
    record.last_status_change_at,
    opp.dateUpdated,
    record.date_updated,
    record.updated_at,
  ];
  for (const c of candidates) {
    const t = parseIsoTimestamp(c);
    if (t != null) return t;
  }
  return null;
}

/**
 * Accumulates per-pipeline data-quality signals as we iterate opportunities.
 * One instance is created per campaign (per pipeline fetch), fed via the
 * onOpp callback on getOpportunityCountsByStagePerMonth.
 */
class QualityAccumulator {
  private openCount = 0;
  private staleOpenCount = 0;
  private lastManualStageChangeMs: number | null = null;
  private readonly nowMs = Date.now();
  private readonly staleCutoffMs = this.nowMs - STALE_OPEN_DAYS * 86400_000;

  constructor(
    private readonly customMappings?: Parameters<
      typeof getEffectiveMapping
    >[1]
  ) {}

  accept = (opp: GHLOpportunity, stageName: string): void => {
    const mapping = getEffectiveMapping(stageName, this.customMappings);
    if (!mapping) return;

    const status = typeof opp.status === "string" ? opp.status.toLowerCase() : "";
    const isOpen = status === "" || status === "open";

    // Current stale-open backlog: opps sitting in automated stages without
    // being moved forward, regardless of when they were created.
    if (isOpen && OPEN_AUTO_STAGES.has(mapping)) {
      this.openCount += 1;
      const lastChange = extractLastStageChange(opp);
      if (lastChange != null && lastChange < this.staleCutoffMs) {
        this.staleOpenCount += 1;
      }
    }

    // Most recent sign the client actually touched a manual stage. Used as
    // a secondary signal — a client who hasn't updated showed/closed in
    // months is almost certainly producing stale rate metrics.
    if (MANUAL_STAGES.has(mapping)) {
      const lastChange = extractLastStageChange(opp);
      if (lastChange != null) {
        if (
          this.lastManualStageChangeMs == null ||
          lastChange > this.lastManualStageChangeMs
        ) {
          this.lastManualStageChangeMs = lastChange;
        }
      }
    }
  };

  finalize(movementRatio: number | null): CampaignQualitySignals {
    const staleOpenPct =
      this.openCount > 0 ? this.staleOpenCount / this.openCount : null;
    return {
      movementRatio,
      openCount: this.openCount,
      staleOpenCount: this.staleOpenCount,
      staleOpenPct,
      lastManualStageChangeAt:
        this.lastManualStageChangeMs != null
          ? new Date(this.lastManualStageChangeMs).toISOString()
          : null,
    };
  }
}

/**
 * Movement ratio = (showed + noShow + closed) / (totalAppts + showed +
 * noShow + closed) across all "aged" days in the window. Days within
 * MOVEMENT_GRACE_DAYS of today are excluded so we don't penalize
 * legitimately-in-flight appointments. Returns null when there's not enough
 * signal (no appointments at all in aged days).
 */
function computeMovementRatio(
  dayRows: Array<{ date: string; metrics: FunnelMetrics }>
): number | null {
  const cutoffMs = Date.now() - MOVEMENT_GRACE_DAYS * 86400_000;
  let movedPast = 0;
  let totalReached = 0;
  for (const row of dayRows) {
    const t = Date.parse(row.date);
    if (!Number.isFinite(t) || t > cutoffMs) continue;
    const m = row.metrics;
    const reached = m.totalAppts + m.showed + m.noShow + m.closed;
    if (reached <= 0) continue;
    totalReached += reached;
    movedPast += m.showed + m.noShow + m.closed;
  }
  if (totalReached <= 0) return null;
  return movedPast / totalReached;
}

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
  // The widest date window we need — earliest month's startDate through
  // latest month's endDate. Used for day-grained GHL + Meta fetches.
  const sortedRanges = monthRanges
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const windowRange = {
    startDate: sortedRanges[0]?.startDate ?? "",
    endDate: sortedRanges[sortedRanges.length - 1]?.endDate ?? "",
  };

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
          windowRange,
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
            await upsertCampaignRuns([
              {
                snapshotId,
                campaignKey: campaign.campaignKey,
                locationId: campaign.locationId,
                status: "error",
                errorMessage: message,
              },
            ]);
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
 * campaign individually and fetch its opportunity counts + Meta spend at
 * day grain. Each OK campaign writes one row per day that had activity; a
 * `campaign_runs` row is written for every campaign regardless of outcome.
 */
async function processLocation(args: {
  snapshotId: number;
  locationId: string;
  campaignsAtLocation: ActiveCampaign[];
  windowRange: { startDate: string; endDate: string };
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
    windowRange,
    getFbCampaigns,
    onCampaignResult,
    pushError,
  } = args;

  const stored = await getToken(locationId);
  if (!stored) {
    const reason = "No OAuth token — app not installed for this location.";
    for (const c of campaignsAtLocation) {
      await upsertCampaignWithoutPipeline(c, reason);
      await upsertCampaignRuns([
        {
          snapshotId,
          campaignKey: c.campaignKey,
          locationId: c.locationId,
          status: "skipped",
          errorMessage: reason,
        },
      ]);
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

  // Per-pipeline cache: two campaigns pointing at the same pipeline (rare
  // but possible) only fetch once. Also holds the quality accumulator that
  // was fed during the fetch so callers pick up both results in one shot.
  const oppCountsCache = new Map<
    string,
    Promise<{
      perDay: Awaited<ReturnType<typeof getOpportunityCountsByStagePerDay>>;
      quality: QualityAccumulator;
    }>
  >();

  for (const campaign of campaignsAtLocation) {
    const resolution = resolvePipeline(campaign, pipelines);
    if (!resolution.pipeline) {
      await upsertCampaignWithoutPipeline(campaign, resolution.reason);
      await upsertCampaignRuns([
        {
          snapshotId,
          campaignKey: campaign.campaignKey,
          locationId: campaign.locationId,
          status: "skipped",
          errorMessage: resolution.reason,
        },
      ]);
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
      const quality = new QualityAccumulator(customMappings);
      oppFetch = getOpportunityCountsByStagePerDay(
        locationId,
        pipeline,
        stored.access_token,
        windowRange,
        attributionMode,
        { onOpp: quality.accept }
      ).then((perDay) => ({ perDay, quality }));
      oppCountsCache.set(pipeline.id, oppFetch);
    }
    const { perDay, quality } = await oppFetch;

    // Manual spend overrides live at monthly granularity (set per pipeline
    // in location settings). We treat each month's override as a flat spend
    // applied to every day of that month that has ad activity — the old
    // monthly rollup effectively did the same thing.
    const configuredAdSpend = settings?.adSpend?.[pipeline.id] ?? {};

    const fbSpendByDay = await resolveCampaignSpendByDay({
      campaign,
      windowRange,
      getFbCampaigns,
    });

    const daysWithMetrics = perDay.map((d) => ({
      date: d.date,
      metrics: calculateFunnelMetrics(
        d.counts,
        d.values,
        pipeline.stages ?? undefined,
        customMappings
      ),
    }));

    const dayRows = buildDayRows({
      snapshotId,
      campaign,
      daysWithMetrics,
      fbSpendByDay,
      configuredAdSpend,
    });

    const qualitySignals = quality.finalize(
      computeMovementRatio(daysWithMetrics)
    );

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
        ...qualitySignals,
      },
    ]);

    if (dayRows.length > 0) await insertCampaignDays(dayRows);
    await upsertCampaignRuns([
      {
        snapshotId,
        campaignKey: campaign.campaignKey,
        locationId: campaign.locationId,
        status: "ok",
        errorMessage: null,
      },
    ]);

    onCampaignResult("ok");
  }
}

/**
 * Merge GHL per-day metrics with per-day ad spend into flat day rows.
 *
 * Manual ad-spend overrides live at MONTHLY granularity (set once per
 * pipeline in location settings). To preserve the per-month total at day
 * grain, we evenly distribute a month's manual value across every day of
 * that month and ignore the API daily spend for the same month — matching
 * the old monthly behavior where manual fully replaced the API number.
 *
 * A day that only has ad spend (no GHL activity) still gets a row so ROAS
 * / CPL charts over partial-month windows include the spend.
 */
function buildDayRows(args: {
  snapshotId: number;
  campaign: ActiveCampaign;
  daysWithMetrics: Array<{ date: string; metrics: FunnelMetrics }>;
  fbSpendByDay: Record<string, number>;
  configuredAdSpend: Record<string, number>;
}): AgencyCampaignDay[] {
  const { snapshotId, campaign, daysWithMetrics, fbSpendByDay, configuredAdSpend } =
    args;

  const metricsByDate = new Map<string, FunnelMetrics>();
  for (const d of daysWithMetrics) metricsByDate.set(d.date, d.metrics);

  // Compute manual daily spend per month (manual total / days in month).
  const manualDailyByMonth = new Map<string, number>();
  for (const [monthKey, manualTotal] of Object.entries(configuredAdSpend)) {
    const total = Number(manualTotal ?? 0);
    if (!(total > 0)) continue;
    const [yStr, mStr] = monthKey.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (!y || !m) continue;
    // JS: new Date(y, m, 0) returns last day of month m.
    const daysInMonth = new Date(y, m, 0).getDate();
    if (daysInMonth > 0) manualDailyByMonth.set(monthKey, total / daysInMonth);
  }

  // Union of days with any activity — keeps the table sparse.
  const activeDays = new Set<string>();
  for (const d of daysWithMetrics) activeDays.add(d.date);
  for (const day of Object.keys(fbSpendByDay)) {
    if (fbSpendByDay[day] > 0) activeDays.add(day);
  }
  // Also include every day of a manual-override month so the monthly total
  // is preserved even when there's no GHL activity on some days.
  if (manualDailyByMonth.size > 0) {
    for (const monthKey of manualDailyByMonth.keys()) {
      const [yStr, mStr] = monthKey.split("-");
      const y = Number(yStr);
      const m = Number(mStr);
      if (!y || !m) continue;
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        activeDays.add(`${monthKey}-${String(d).padStart(2, "0")}`);
      }
    }
  }

  const rows: AgencyCampaignDay[] = [];
  for (const date of activeDays) {
    const m = metricsByDate.get(date);
    const monthKey = date.slice(0, 7);
    const manualDaily = manualDailyByMonth.get(monthKey);
    // Manual override fully replaces API when set (legacy behavior).
    const adSpend =
      manualDaily != null ? manualDaily : Number(fbSpendByDay[date] ?? 0);

    rows.push({
      snapshotId,
      campaignKey: campaign.campaignKey,
      locationId: campaign.locationId,
      date,
      leads: m?.leads ?? 0,
      totalAppts: m?.totalAppts ?? 0,
      showed: m?.showed ?? 0,
      noShow: m?.noShow ?? 0,
      closed: m?.closed ?? 0,
      totalValue: m?.totalValue ?? 0,
      successValue: m?.successValue ?? 0,
      adSpend,
    });
  }
  return rows;
}

interface PipelineResolution {
  pipeline: GHLPipeline | null;
  reason: string;
}

/**
 * Pipelines whose names contain ❌ are treated as explicitly retired by the
 * client and should never be chosen — even if they match the column I keyword.
 * This lets us keep the old/archived pipeline around in GHL for historical
 * reference without tripping up the rollup.
 */
const RETIRED_MARKER = "\u274c"; // ❌

function isRetired(pipeline: GHLPipeline): boolean {
  return (pipeline.name ?? "").includes(RETIRED_MARKER);
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

  const eligible = pipelines.filter((p) => !isRetired(p));
  if (eligible.length === 0) {
    return {
      pipeline: null,
      reason: `All ${pipelines.length} pipelines at this location are marked with ❌.`,
    };
  }

  const keyword = campaign.pipelineKeyword?.trim();
  if (keyword) {
    const kw = keyword.toLowerCase();
    const matches = eligible.filter((p) =>
      (p.name ?? "").toLowerCase().includes(kw)
    );
    if (matches.length === 1) {
      return { pipeline: matches[0], reason: "" };
    }
    if (matches.length > 1) {
      return {
        pipeline: null,
        reason: `Column I "${keyword}" matched ${matches.length} pipelines (excluding ❌): ${matches
          .map((p) => p.name)
          .join(", ")}. Make the keyword more specific.`,
      };
    }
    // no match with keyword — fall through to single-pipeline fallback
  }

  if (eligible.length === 1) {
    return { pipeline: eligible[0], reason: "" };
  }

  const available = eligible.map((p) => p.name).join(", ");
  return {
    pipeline: null,
    reason: keyword
      ? `No GHL pipeline name contains "${keyword}" (after excluding ❌). Available: ${available}.`
      : `Location has ${eligible.length} pipelines and column I is empty. Available: ${available}.`,
  };
}

/**
 * Resolve ad spend for a campaign at DAY granularity over the window. Meta
 * is called with time_increment=1 so we get one row per spend-day. Returns
 * a sparse `{ "YYYY-MM-DD": spend }` map — days with zero spend are absent.
 */
async function resolveCampaignSpendByDay(args: {
  campaign: ActiveCampaign;
  windowRange: { startDate: string; endDate: string };
  getFbCampaigns: (
    adAccountId: string
  ) => Promise<{ campaigns: FacebookCampaign[]; error?: string }>;
}): Promise<Record<string, number>> {
  const { campaign, windowRange, getFbCampaigns } = args;
  if (!campaign.adAccountId) return {};
  const { startDate, endDate } = windowRange;
  if (!startDate || !endDate) return {};

  const keyword = campaign.campaignKeyword?.trim();

  if (!keyword) {
    try {
      const { spendByDate } = await fetchSpendByDay(
        campaign.adAccountId,
        false,
        startDate,
        endDate
      );
      return spendByDate;
    } catch (err) {
      console.warn(
        `[agency-rollup-runner] account-level daily spend failed for ${campaign.locationId}:`,
        err
      );
      return {};
    }
  }

  // Keyword filter: list FB campaigns (cached per ad account), match by
  // name, aggregate daily spend across matches.
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
  if (matches.length === 0) return {};

  const aggregated: Record<string, number> = {};
  for (const fb of matches) {
    try {
      const { spendByDate, error: spendErr } = await fetchSpendByDay(
        fb.id,
        true,
        startDate,
        endDate
      );
      if (spendErr) continue;
      for (const [date, amount] of Object.entries(spendByDate)) {
        aggregated[date] = (aggregated[date] ?? 0) + amount;
      }
    } catch (err) {
      console.warn(
        `[agency-rollup-runner] daily spend failed for FB campaign ${fb.id}:`,
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
      movementRatio: null,
      openCount: null,
      staleOpenCount: null,
      staleOpenPct: null,
      lastManualStageChangeAt: null,
    },
  ]);
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
