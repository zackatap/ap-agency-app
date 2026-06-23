/**
 * Builds the JSON feed that replaces the Zapier "Get Many Rows" read of the
 * Attention Dashboard sheet. One object per active/2nd-cmpn campaign, carrying
 * the same KPIs (ad spend, leads, CPL, link clicks, CPLC, CTR) for the 3/7/30
 * day windows with current / prior / delta — sourced straight from the rollup
 * snapshot via {@link buildAgencyRollupView}, the same data the Scorecard uses.
 */

import {
  buildAgencyRollupView,
  type CampaignSummary,
  type CampaignWindowTotals,
} from "@/lib/agency-rollup-view";
import {
  getDateRangeForPreset,
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";

/** Supported trailing windows and the rollup preset each maps to. */
const WINDOW_PRESETS: Record<number, DateRangePreset> = {
  3: "last_3",
  7: "last_7",
  30: "last_30",
};

export const ATTENTION_WINDOWS = [3, 7, 30] as const;

/** Metrics emitted per window, with the output key prefix used in the feed. */
const FEED_METRICS: Array<{
  key: keyof CampaignWindowTotals;
  out: string;
}> = [
  { key: "adSpend", out: "ad_spend" },
  { key: "leads", out: "leads" },
  { key: "cpl", out: "cpl" },
  { key: "linkClicks", out: "link_clicks" },
  { key: "cplc", out: "cplc" },
  { key: "ctr", out: "ctr" },
];

function num(totals: CampaignWindowTotals, key: keyof CampaignWindowTotals): number | null {
  const raw = totals[key];
  return typeof raw === "number" ? raw : null;
}

function round(value: number, decimals: number): number {
  const scale = Math.pow(10, decimals);
  return Math.round(value * scale) / scale;
}

/** Counts stay whole; money/rate metrics keep 2 decimals. */
function decimalsFor(out: string): number {
  return out === "leads" || out === "link_clicks" ? 0 : 2;
}

export interface AttentionFeedResult {
  snapshotId: number | null;
  snapshotFinishedAt: string | null;
  windows: number[];
  rows: Array<Record<string, unknown>>;
}

/**
 * @param windows Which trailing windows to include (defaults to all of 3/7/30).
 *   Reads the day table once per window — fine for a scheduled Zapier poll.
 */
export async function buildAttentionFeed(opts?: {
  windows?: number[];
}): Promise<AttentionFeedResult> {
  const windows = (opts?.windows ?? [...ATTENTION_WINDOWS])
    .filter((w) => w in WINDOW_PRESETS)
    .sort((a, b) => a - b);

  const today = getTodayLocal();

  // Build one rollup view per requested window. Each is a Neon read of the
  // latest complete snapshot aggregated over that window + its prior period.
  const views = await Promise.all(
    windows.map(async (w) => {
      const preset = WINDOW_PRESETS[w];
      const { startDate, endDate } = getDateRangeForPreset(
        preset,
        undefined,
        undefined,
        today
      );
      const view = await buildAgencyRollupView({
        onTotals: true,
        range: {
          preset,
          startDate,
          endDate,
          label: DATE_RANGE_LABELS[preset],
        },
      });
      return { window: w, view };
    })
  );

  const firstView = views.find((v) => v.view)?.view ?? null;
  if (!firstView) {
    return {
      snapshotId: null,
      snapshotFinishedAt: null,
      windows,
      rows: [],
    };
  }

  // Index every window's campaigns by campaignKey so we can merge per campaign.
  const byWindow = new Map<number, Map<string, CampaignSummary>>();
  for (const { window, view } of views) {
    const map = new Map<string, CampaignSummary>();
    if (view) {
      for (const c of view.campaigns) map.set(c.campaignKey, c);
    }
    byWindow.set(window, map);
  }

  // Roster comes from the first view; campaign sets are identical across
  // windows (same snapshot), so this covers everyone.
  const rows: Array<Record<string, unknown>> = [];
  for (const base of firstView.campaigns) {
    const row: Record<string, unknown> = {
      campaign_key: base.campaignKey,
      cid: base.cid,
      client_name: base.businessName,
      owner_name: base.ownerName,
      status: base.status,
      ad_account_id: base.adAccountId,
      location_id: base.locationId,
      pipeline_name: base.pipelineName,
      campaign_name: base.campaignKeyword ?? base.pipelineName,
      included: base.included,
      needs_setup: Boolean(base.needsSetupReason),
    };

    for (const w of windows) {
      const summary = byWindow.get(w)?.get(base.campaignKey);
      for (const metric of FEED_METRICS) {
        const prefix = `${metric.out}_${w}d`;
        const cur = summary ? num(summary.totals, metric.key) : null;
        const prev = summary ? num(summary.priorTotals, metric.key) : null;
        const decimals = decimalsFor(metric.out);
        row[prefix] = cur == null ? null : round(cur, decimals);
        row[`${prefix}_prev`] = prev == null ? null : round(prev, decimals);
        row[`${prefix}_delta`] =
          cur == null || prev == null ? null : round(cur - prev, decimals);
      }
    }

    rows.push(row);
  }

  return {
    snapshotId: firstView.snapshot.id,
    snapshotFinishedAt: firstView.snapshot.finishedAt,
    windows,
    rows,
  };
}
