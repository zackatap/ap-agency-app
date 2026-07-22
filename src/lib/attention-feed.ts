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
 * (column BC). Quantity flags are computed by {@link computeAttentionFlag};
 * Quality (funnel) flags by {@link computeQualityFlag}.
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
  computeLeadDataFlag,
  type AttentionMetrics,
} from "@/lib/attention-flags";
import {
  computeQualityFlag,
  type QualityMetrics,
} from "@/lib/quality-flags";
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
  { key: "metaLeads", out: "leads" },
  { key: "leads", out: "crm_leads" },
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
  return out === "leads" || out === "crm_leads" || out === "link_clicks"
    ? 0
    : 2;
}

/**
 * CPL the way the sheet computed it: spend / leads. That's $0 when spend is $0
 * but leads exist (a paused-ads campaign still pulling leads), and null only
 * when there are no leads to divide by.
 *
 * The rollup view nulls CPL at $0 spend for display, but the flag logic needs
 * the numeric 0 — otherwise the 14d/7d CPL-delta ISNUMBER guards short-circuit
 * and the "$0 ad spend in 3 days" (S_O4) flag can never fire for fully-paused
 * campaigns. The sheet's CPL was numeric here, so this matches it.
 */
/** CPL = spend / Meta-attributed leads (matches Ads Manager + scorecard). */
function sheetCpl(totals: CampaignWindowTotals | undefined): number | null {
  if (!totals) return null;
  const spend = totals.adSpend;
  const leads = totals.metaLeads;
  if (typeof spend !== "number" || typeof leads !== "number" || leads <= 0) {
    return null;
  }
  // Round to cents to match the rollup view's moneyOrNull, so spend>0 campaigns
  // are byte-for-byte identical and only $0-spend ones change (null -> 0).
  return Math.round((spend / leads) * 100) / 100;
}

/** CPL dollar delta (current minus prior) for a window, null if either side is null. */
function cplDelta(summary: CampaignSummary | undefined): number | null {
  if (!summary) return null;
  const cur = sheetCpl(summary.totals);
  const prev = sheetCpl(summary.priorTotals);
  if (cur == null || prev == null) return null;
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
 * @param flaggedOnly When true, returns only campaigns with an Ads *performance*
 *   flag (lead/CPL/spend) — the original Zapier Attention Dashboard view.
 *   Meta↔CRM Data flags alone do not qualify. Shorthand for
 *   `flaggedMode: "quantity"`.
 * @param flaggedMode Which flag category a row must have to be returned:
 *   "quantity" (Ads performance only — Zapier), "quality" (funnel), or
 *   "either" (Ads performance, Ads Data, or Quality — in-app KPI tab).
 *   Takes precedence over `flaggedOnly`. When unset and `flaggedOnly` is
 *   false, all rows return.
 * @param urgency When set (e.g. 0 for red), only rows whose *performance*
 *   Ads urgency matches are returned. Ignored when no flag filter is active.
 */
export async function buildAttentionFeed(opts?: {
  windows?: number[];
  flaggedOnly?: boolean;
  flaggedMode?: "quantity" | "quality" | "either";
  urgency?: number;
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
      metaLeads3d: s3?.totals.metaLeads ?? 0,
      metaLeads7d: s7?.totals.metaLeads ?? 0,
      crmLeads7d: s7?.totals.leads ?? 0,
      cpl7d: sheetCpl(s7?.totals),
      cpl30d: sheetCpl(s30?.totals),
      cpl30dPrev: sheetCpl(s30?.priorTotals),
      cplDelta14d: cplDelta(s14),
      cplDelta7d: cplDelta(s7),
      cplDelta3d: cplDelta(s3),
      adSpend3d: s3?.totals.adSpend ?? 0,
      adSpend30d: s30?.totals.adSpend ?? 0,
    };
    // Only flag campaigns that actually ran this snapshot — needs-setup /
    // skipped campaigns carry no real signal, and now that the lead/spend rules
    // fire off raw counts they'd otherwise alert on empty rows.
    const flag = base.included ? computeAttentionFlag(metrics) : null;
    // Meta↔CRM leak is independent: Data badge can sit next to a performance
    // flag so a sync gap never hides a real CPL / lead-volume problem.
    const dataFlag = base.included ? computeLeadDataFlag(metrics) : null;

    // Quality (funnel) flags run off the same rollup windows. 30d drives the
    // absolute-rate rules; the 14d summary carries its own prior period, which
    // is exactly the "vs prior 14 days" trend the show-rate drop rule needs.
    const qualityMetrics: QualityMetrics = {
      businessName: base.businessName,
      appts30d: s30?.totals.totalAppts ?? 0,
      showed30d: s30?.totals.showed ?? 0,
      noShow30d: s30?.totals.noShow ?? 0,
      closed30d: s30?.totals.closed ?? 0,
      leads30d: s30?.totals.leads ?? 0,
      bookingRate30d: s30?.totals.bookingRate ?? null,
      showRate30d: s30?.totals.showRate ?? null,
      closeRate30d: s30?.totals.closeRate ?? null,
      showRate14d: s14?.totals.showRate ?? null,
      showRate14dPrev: s14?.priorTotals.showRate ?? null,
      appts14d: s14?.totals.totalAppts ?? 0,
      appts14dPrev: s14?.priorTotals.totalAppts ?? 0,
    };
    const qualityFlag = base.included ? computeQualityFlag(qualityMetrics) : null;

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
      // Ads performance (R/O/Y). Zapier maps these as the primary attention fields.
      flagged: flag != null,
      attention_code: flag?.code ?? "-",
      reason: flag?.reason ?? "",
      urgency: flag?.urgency ?? null,
      // Ads Data (Meta↔CRM leak) — parallel to performance, never replaces it.
      data_flagged: dataFlag != null,
      data_code: dataFlag?.code ?? "-",
      data_reason: dataFlag?.reason ?? "",
      data_urgency: dataFlag?.urgency ?? null,
      // Quality (funnel) flag — the account-manager signal.
      quality_flagged: qualityFlag != null,
      quality_code: qualityFlag?.code ?? "-",
      quality_reason: qualityFlag?.reason ?? "",
      quality_urgency: qualityFlag?.urgency ?? null,
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

  // "quantity" = Ads performance only (Zapier / media-buyer tasks).
  // "either" includes Ads Data leaks so the KPI tab can show them without
  // creating empty ClickUp rows when only a sync gap fires.
  const mode: "quantity" | "quality" | "either" | null =
    opts?.flaggedMode ?? (opts?.flaggedOnly ? "quantity" : null);

  let finalRows = rows;
  if (mode) {
    finalRows = rows
      .filter((r) => {
        const perf = r.flagged === true;
        const data = r.data_flagged === true;
        const ql = r.quality_flagged === true;
        if (mode === "quantity") return perf;
        if (mode === "quality") return ql;
        return perf || data || ql;
      })
      // Sheet's `NOT B LIKE '%*%'`: drop paused/internal names marked with "*".
      .filter((r) => !String(r.client_name ?? "").includes("*"));
    // Urgency filter targets Ads performance (Zapier "red only").
    if (typeof opts?.urgency === "number" && mode !== "quality") {
      finalRows = finalRows.filter((r) => r.urgency === opts.urgency);
    }
    // Sort by the most urgent flag across Ads performance, Ads Data, and Quality.
    const rank = (r: Record<string, unknown>) =>
      Math.min(
        typeof r.urgency === "number" ? r.urgency : 99,
        typeof r.data_urgency === "number" ? r.data_urgency : 99,
        typeof r.quality_urgency === "number" ? r.quality_urgency : 99
      );
    finalRows = finalRows.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
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
