/**
 * Builds the JSON feed that replaces the Zapier "Get Many Rows" read of the
 * Attention Dashboard sheet. One object per active/2nd-cmpn campaign, carrying
 * the KPIs (ad spend, leads, CPL, link clicks, CPLC, CTR) for the 3/7/14/30 day
 * windows with current / prior / delta, plus the sheet's derived attention
 * fields: flag code, reason, urgency, the CPL "$ more/less" status, and the
 * ClickUp relationship ID.
 *
 * Data comes from the rollup snapshot via {@link buildAgencyRollupView} (the
 * same source the Scorecard uses); the ClickUp ID comes live from the Client DB
 * (column BC). Flags are computed by {@link computeAttentionFlag}.
 */

import {
  buildAgencyRollupView,
  type AgencyRollupView,
  type CampaignSummary,
  type CampaignWindowTotals,
} from "@/lib/agency-rollup-view";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  isoToLocalDateString,
  shiftDateString,
  type DateRangePreset,
} from "@/lib/date-ranges";
import {
  computeAttentionFlag,
  type AttentionMetrics,
} from "@/lib/attention-flags";
import { getLatestCompleteSnapshot } from "@/lib/agency-rollup-store";
import { fetchClickUpRelationMap } from "@/lib/google-sheets";

/** Supported trailing windows and the rollup preset each maps to. */
const WINDOW_PRESETS: Record<number, DateRangePreset> = {
  3: "last_3",
  7: "last_7",
  14: "last_14",
  30: "last_30",
};

export const ATTENTION_WINDOWS = [3, 7, 14, 30] as const;

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

/** CPL dollar delta (current minus prior) for a window, null if either side is null. */
function cplDelta(summary: CampaignSummary | undefined): number | null {
  if (!summary) return null;
  const cur = summary.totals.cpl;
  const prev = summary.priorTotals.cpl;
  if (typeof cur !== "number" || typeof prev !== "number") return null;
  return cur - prev;
}

export interface AttentionFeedResult {
  snapshotId: number | null;
  snapshotFinishedAt: string | null;
  windows: number[];
  rows: Array<Record<string, unknown>>;
}

/**
 * @param windows Which trailing windows to include as metric columns (defaults
 *   to all of 3/7/14/30). Flags are always computed from all four windows
 *   regardless of this setting.
 * @param flaggedOnly When true, returns only campaigns that have an attention
 *   flag (matching the sheet's `CI <> '-'` filter), excludes client names with
 *   `*`, and sorts by urgency then name. This is the Attention Dashboard view.
 */
export async function buildAttentionFeed(opts?: {
  windows?: number[];
  flaggedOnly?: boolean;
  /** Viewer tz so windows align with the KPI table's refresh-date anchor. */
  tz?: string;
}): Promise<AttentionFeedResult> {
  const outputWindows = (opts?.windows ?? [...ATTENTION_WINDOWS])
    .filter((w) => w in WINDOW_PRESETS)
    .sort((a, b) => a - b);

  // Anchor every window to the snapshot's refresh date (exact N days ending on
  // it), identical to the KPI table — so a "7-day" flag is computed over the
  // same dates the table shows. Falls back to today if no snapshot yet.
  const snap = await getLatestCompleteSnapshot();
  const anchor = snap?.finishedAt
    ? isoToLocalDateString(snap.finishedAt, opts?.tz)
    : getTodayLocal();

  // Always build all four windows: flags need 3/7/14/30 even if the caller only
  // wants a subset of metric columns. Each is a Neon read of the latest
  // complete snapshot aggregated over that window + its prior period.
  const allWindows = [...ATTENTION_WINDOWS];
  const [views, relationMap] = await Promise.all([
    Promise.all(
      allWindows.map(async (w) => {
        const preset = WINDOW_PRESETS[w];
        const endDate = anchor;
        const startDate = shiftDateString(anchor, -(w - 1));
        const view = await buildAgencyRollupView({
          onTotals: true,
          range: { preset, startDate, endDate, label: DATE_RANGE_LABELS[preset] },
        });
        return { window: w, view };
      })
    ),
    fetchClickUpRelationMap(),
  ]);

  const byWindow = new Map<number, Map<string, CampaignSummary>>();
  let baseView: AgencyRollupView | null = null;
  for (const { window, view } of views) {
    const map = new Map<string, CampaignSummary>();
    if (view) {
      for (const c of view.campaigns) map.set(c.campaignKey, c);
      if (!baseView) baseView = view;
    }
    byWindow.set(window, map);
  }

  if (!baseView) {
    return { snapshotId: null, snapshotFinishedAt: null, windows: outputWindows, rows: [] };
  }

  const w3 = byWindow.get(3)!;
  const w7 = byWindow.get(7)!;
  const w14 = byWindow.get(14)!;
  const w30 = byWindow.get(30)!;

  const rows: Array<Record<string, unknown>> = [];
  for (const base of baseView.campaigns) {
    const key = base.campaignKey;
    const s3 = w3.get(key);
    const s7 = w7.get(key);
    const s14 = w14.get(key);
    const s30 = w30.get(key);
    const campaignName = base.campaignKeyword ?? base.pipelineName;

    const metrics: AttentionMetrics = {
      businessName: base.businessName,
      campaignName,
      leads3d: s3?.totals.leads ?? 0,
      leads7d: s7?.totals.leads ?? 0,
      cpl7d: s7?.totals.cpl ?? null,
      cpl30d: s30?.totals.cpl ?? null,
      cpl30dPrev: s30?.priorTotals.cpl ?? null,
      cplDelta14d: cplDelta(s14),
      cplDelta7d: cplDelta(s7),
      cplDelta3d: cplDelta(s3),
      adSpend3d: s3?.totals.adSpend ?? 0,
      adSpend30d: s30?.totals.adSpend ?? 0,
    };
    const flag = computeAttentionFlag(metrics);

    const relationId =
      relationMap.byLocation.get(base.locationId) ??
      (base.cid ? relationMap.byCid.get(base.cid) : undefined) ??
      "";

    const row: Record<string, unknown> = {
      campaign_key: key,
      cid: base.cid,
      client_name: base.businessName,
      owner_name: base.ownerName,
      status: base.status,
      ad_account_id: base.adAccountId,
      location_id: base.locationId,
      pipeline_name: base.pipelineName,
      campaign_name: campaignName,
      included: base.included,
      needs_setup: Boolean(base.needsSetupReason),
      // Attention Dashboard fields (the sheet's derived columns). The sheet's
      // "STATUS" column is this code (S_R4, S_O3, ...); `status` above is the
      // ACTIVE / 2ND CMPN campaign status, a different thing.
      flagged: flag != null,
      attention_code: flag?.code ?? "-",
      reason: flag?.reason ?? "",
      urgency: flag?.urgency ?? null,
      clickup_relation_id: relationId,
    };

    for (const w of outputWindows) {
      const summary = byWindow.get(w)?.get(key);
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

  let finalRows = rows;
  if (opts?.flaggedOnly) {
    finalRows = rows
      .filter((r) => r.flagged === true)
      // Sheet's `NOT B LIKE '%*%'`: drop paused/internal names marked with "*".
      .filter((r) => !String(r.client_name ?? "").includes("*"))
      .sort((a, b) => {
        const ua = (a.urgency as number | null) ?? 99;
        const ub = (b.urgency as number | null) ?? 99;
        if (ua !== ub) return ua - ub;
        return String(a.client_name ?? "").localeCompare(String(b.client_name ?? ""));
      });
  }

  return {
    snapshotId: baseView.snapshot.id,
    snapshotFinishedAt: baseView.snapshot.finishedAt,
    windows: outputWindows,
    rows: finalRows,
  };
}
