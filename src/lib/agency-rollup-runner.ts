/**
 * Runs a rollup refresh: enumerates active clients, fetches 13 months of funnel
 * data + Facebook ad spend per location, and persists the results to the
 * agency_rollup_* tables.
 *
 * Concurrency is capped at ROLLUP_CONCURRENCY locations in flight. Each per-
 * location failure is captured and does not abort the run — the snapshot is
 * still marked `complete` as long as some locations succeeded.
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
import { fetchSpendByMonth } from "@/lib/facebook-ads";
import { listActiveClients, type ActiveClient } from "@/lib/agency-clients";
import {
  createSnapshot,
  finishSnapshot,
  insertLocationMonths,
  updateSnapshotProgress,
  upsertClients,
  getRunningSnapshot,
  expireStaleRunningSnapshots,
  type AgencyLocationMonth,
} from "@/lib/agency-rollup-store";

const ROLLUP_CONCURRENCY = 6;
const DEFAULT_MONTHS = 13;

export interface StartRollupParams {
  monthsCovered?: number;
  triggeredBy?: "manual" | "cron";
  /**
   * When true, skip starting if a run is already active. We always expire any
   * `running` snapshot older than ~20 minutes first so a crashed run does not
   * lock the button forever.
   */
  skipIfRunning?: boolean;
  /** Process at most this many clients. Useful for testing/debugging. */
  limit?: number;
  /**
   * Optional hook for `after()` / `waitUntil()` so serverless platforms keep
   * the function alive until the background work finishes. Vercel kills
   * dangling promises the moment the response returns, which previously
   * caused the runner to be terminated within seconds of starting.
   */
  waitUntil?: (promise: Promise<void>) => void;
}

export interface StartRollupResult {
  status: "started" | "already-running" | "error";
  snapshotId?: number;
  message?: string;
}

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

  // Bind lifetime to the hosting platform's background-work hook when
  // provided. Vercel: after(). Otherwise, fire-and-forget with a dangling
  // reference so Node does not GC the promise (e.g. long-lived servers).
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
  const errors: Array<{
    locationId?: string;
    businessName?: string;
    message: string;
  }> = [];

  await updateSnapshotProgress(snapshotId, {
    progressLabel: "Loading client roster",
  });

  const { clients: allClients, error: sheetError } = await listActiveClients();
  if (sheetError) {
    errors.push({ message: `Sheet load failed: ${sheetError}` });
  }

  const clients = limit ? allClients.slice(0, limit) : allClients;
  if (limit && allClients.length > limit) {
    console.info(
      `[agency-rollup-runner] limit=${limit} applied (of ${allClients.length} active clients).`
    );
  }

  if (clients.length === 0) {
    await finishSnapshot(snapshotId, {
      status: "failed",
      clientsIncluded: 0,
      clientsFailed: 0,
      errors: [
        ...errors,
        { message: "No active clients found in Client Database." },
      ],
    });
    return;
  }

  const monthRanges = getMonthsBack(months);
  const monthKeys = monthRanges.map((m) => m.monthKey);

  await updateSnapshotProgress(snapshotId, {
    clientsTotal: clients.length,
    progressTotal: clients.length,
    progressCurrent: 0,
    progressLabel: `Fetching data for ${clients.length} clients`,
  });

  let completed = 0;
  let included = 0;
  let failed = 0;

  await runWithConcurrency(clients, ROLLUP_CONCURRENCY, async (client) => {
    try {
      const result = await processClient(client, monthRanges);

      if (result.kind === "ok") {
        await upsertClients([
          {
            locationId: client.locationId,
            cid: client.cid,
            businessName: client.businessName,
            ownerFirstName: client.ownerFirstName,
            ownerLastName: client.ownerLastName,
            statuses: client.statuses,
            pipelineId: result.pipeline.id,
            pipelineName: result.pipeline.name,
            adAccountId: client.adAccountId,
          },
        ]);
        await insertLocationMonths(
          result.monthRows.map<AgencyLocationMonth>((row) => ({
            snapshotId,
            locationId: client.locationId,
            monthKey: row.monthKey,
            startDate: row.startDate,
            endDate: row.endDate,
            metrics: row.metrics,
            adSpend: row.adSpend,
            status: "ok",
            errorMessage: null,
          }))
        );
        included += 1;
      } else {
        await upsertClients([
          {
            locationId: client.locationId,
            cid: client.cid,
            businessName: client.businessName,
            ownerFirstName: client.ownerFirstName,
            ownerLastName: client.ownerLastName,
            statuses: client.statuses,
            pipelineId: null,
            pipelineName: null,
            adAccountId: client.adAccountId,
          },
        ]);
        await insertLocationMonths(
          monthRanges.map<AgencyLocationMonth>((range) => ({
            snapshotId,
            locationId: client.locationId,
            monthKey: range.monthKey,
            startDate: range.startDate,
            endDate: range.endDate,
            metrics: emptyMetrics(),
            adSpend: 0,
            status: "skipped",
            errorMessage: result.reason,
          }))
        );
        failed += 1;
        errors.push({
          locationId: client.locationId,
          businessName: client.businessName ?? undefined,
          message: result.reason,
        });
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({
        locationId: client.locationId,
        businessName: client.businessName ?? undefined,
        message,
      });
      try {
        await insertLocationMonths(
          monthRanges.map<AgencyLocationMonth>((range) => ({
            snapshotId,
            locationId: client.locationId,
            monthKey: range.monthKey,
            startDate: range.startDate,
            endDate: range.endDate,
            metrics: emptyMetrics(),
            adSpend: 0,
            status: "error",
            errorMessage: message,
          }))
        );
      } catch (inner) {
        console.error("[agency-rollup-runner] insert error-row failed:", inner);
      }
    } finally {
      completed += 1;
      if (completed % 2 === 0 || completed === clients.length) {
        await updateSnapshotProgress(snapshotId, {
          progressCurrent: completed,
          clientsIncluded: included,
          clientsFailed: failed,
          progressLabel: `${completed} / ${clients.length} clients`,
        });
      }
    }
  });
  void monthKeys;

  await finishSnapshot(snapshotId, {
    status: "complete",
    clientsIncluded: included,
    clientsFailed: failed,
    errors,
  });
}

type ClientResult =
  | {
      kind: "ok";
      pipeline: GHLPipeline;
      monthRows: Array<{
        monthKey: string;
        startDate: string;
        endDate: string;
        metrics: FunnelMetrics;
        adSpend: number;
      }>;
    }
  | { kind: "skipped"; reason: string };

async function processClient(
  client: ActiveClient,
  monthRanges: Array<{ monthKey: string; startDate: string; endDate: string }>
): Promise<ClientResult> {
  const stored = await getToken(client.locationId);
  if (!stored) {
    return {
      kind: "skipped",
      reason: "No OAuth token — app not installed for this location.",
    };
  }

  const [pipelines, settings] = await Promise.all([
    getPipelines(client.locationId, stored.access_token),
    getLocationSettings(client.locationId),
  ]);

  const pipeline = settings?.defaultPipelineId
    ? pipelines.find((p) => p.id === settings.defaultPipelineId)
    : null;

  if (!pipeline) {
    return {
      kind: "skipped",
      reason: settings?.defaultPipelineId
        ? "Configured default pipeline not found in GHL."
        : "No default pipeline configured in location settings.",
    };
  }

  const attributionMode = settings?.attributionMode ?? "lastUpdated";
  const customMappings = settings?.stageMappings?.[pipeline.id];

  const perMonth = await getOpportunityCountsByStagePerMonth(
    client.locationId,
    pipeline,
    stored.access_token,
    monthRanges,
    attributionMode
  );

  const monthKeys = monthRanges.map((m) => m.monthKey);
  const configuredAdSpend = settings?.adSpend?.[pipeline.id] ?? {};

  let fbSpend: Record<string, number> = {};
  if (client.adAccountId) {
    try {
      const { spendByMonth } = await fetchSpendByMonth(
        client.adAccountId,
        false,
        monthKeys
      );
      fbSpend = spendByMonth;
    } catch (err) {
      console.warn(
        `[agency-rollup-runner] ad spend fetch failed for ${client.locationId}:`,
        err
      );
    }
  }

  const monthRows = perMonth.map((m) => {
    const metrics = calculateFunnelMetrics(
      m.counts,
      m.values,
      pipeline.stages ?? undefined,
      customMappings
    );
    // Prefer manually entered ad spend in location_settings; fall back to FB API
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

  return { kind: "ok", pipeline, monthRows };
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
