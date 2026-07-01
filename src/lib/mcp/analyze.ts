/**
 * Performance diagnostic for a single client, built for the Gleap MCP server.
 *
 * Reads the latest complete rollup snapshot (same source as the agency
 * Scorecard) for a chosen window and the immediately-prior window of equal
 * length, then turns the current-vs-prior deltas into:
 *   - a structured metric table (leads, appts, shows, closes, spend, CPL,
 *     cost/appt, cost/show, cost/close, booking/show/close rate, ROAS), and
 *   - plain-English `findings` the Gleap agent can fold into a drafted reply.
 *
 * It also surfaces data-quality signals (stale open opportunities, last board
 * movement) which usually explain "the leads aren't showing up" complaints:
 * the leads are captured but the client hasn't worked or marked them.
 *
 * The MCP server returns FACTS + FINDINGS; the Gleap agent writes the prose.
 */

import {
  buildAgencyRollupView,
  type CampaignSummary,
  type CampaignWindowTotals,
} from "@/lib/agency-rollup-view";
import {
  DATE_RANGE_LABELS,
  getDateRangeForPreset,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { resolveSingleClient, type ResolvedClient } from "@/lib/mcp/resolve-client";

/** Window presets the analysis accepts (subset of the dashboard presets). */
export type AnalysisPreset =
  | "last_7"
  | "last_14"
  | "last_30"
  | "last_60"
  | "last_90"
  | "this_month"
  | "last_month";

export interface MetricComparison {
  key: string;
  label: string;
  kind: "count" | "money" | "rate" | "ratio";
  current: number | null;
  prior: number | null;
  /** current - prior (null if either side is null). */
  deltaAbs: number | null;
  /** Percent change vs prior (null if prior is 0/null). */
  deltaPct: number | null;
  higherIsBetter: boolean;
  /** "up" | "down" | "flat" | null (null when not comparable). */
  direction: "up" | "down" | "flat" | null;
  /** True when the move is in the good direction, false when bad, null when flat/NA. */
  better: boolean | null;
}

export interface ClientPerformanceAnalysis {
  status: "ok";
  client: {
    locationId: string;
    businessName: string;
    ownerName: string | null;
    cid: string | null;
    adAccountIds: string[];
  };
  alternatives: Array<{ locationId: string; businessName: string }>;
  window: { preset: string; label: string; startDate: string; endDate: string };
  priorWindow: { startDate: string; endDate: string };
  snapshot: { id: number; finishedAt: string | null; ageHours: number | null };
  /** True when the client has campaigns but none ran in this snapshot. */
  noData: boolean;
  metrics: MetricComparison[];
  /** Plain-English observations for the agent to use in a drafted reply. */
  findings: string[];
  dataQuality: {
    openCount: number | null;
    staleOpenCount: number | null;
    staleOpenPct: number | null;
    lastBoardMovementAt: string | null;
  };
}

export type AnalyzeResult =
  | ClientPerformanceAnalysis
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; matches: Array<{ locationId: string; businessName: string }> }
  | { status: "no_snapshot" };

const ZERO_TOTALS: CampaignWindowTotals = {
  leads: 0,
  metaLeads: 0,
  totalAppts: 0,
  showed: 0,
  noShow: 0,
  closed: 0,
  totalValue: 0,
  successValue: 0,
  adSpend: 0,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  bookingRate: null,
  showRate: null,
  closeRate: null,
  cpl: null,
  cps: null,
  cpClose: null,
  cplc: null,
  ctr: null,
  roas: null,
};

function rateOrNull(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

function moneyOrNull(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 100) / 100;
}

/**
 * Sum the count/value fields across a location's campaigns and re-derive rate
 * metrics from the pooled sums. The per-campaign totals are already in
 * "On Totals" shape (downstream stages roll up), so summing the count fields
 * across distinct campaigns and recomputing the ratios is correct.
 */
function combineTotals(list: CampaignWindowTotals[]): CampaignWindowTotals {
  if (list.length === 0) return { ...ZERO_TOTALS };
  const acc = { ...ZERO_TOTALS } as CampaignWindowTotals;
  for (const t of list) {
    acc.leads += t.leads;
    acc.metaLeads += t.metaLeads;
    acc.totalAppts += t.totalAppts;
    acc.showed += t.showed;
    acc.noShow += t.noShow;
    acc.closed += t.closed;
    acc.totalValue += t.totalValue;
    acc.successValue += t.successValue;
    acc.adSpend += t.adSpend;
    acc.impressions += t.impressions;
    acc.clicks += t.clicks;
    acc.linkClicks += t.linkClicks;
  }
  acc.bookingRate = rateOrNull(acc.totalAppts, acc.leads);
  acc.showRate = rateOrNull(acc.showed, acc.totalAppts);
  acc.closeRate = rateOrNull(acc.closed, acc.showed);
  acc.cpl =
    acc.adSpend > 0 && acc.metaLeads > 0
      ? moneyOrNull(acc.adSpend, acc.metaLeads)
      : null;
  acc.cps = acc.adSpend > 0 ? moneyOrNull(acc.adSpend, acc.showed) : null;
  acc.cpClose = acc.adSpend > 0 ? moneyOrNull(acc.adSpend, acc.closed) : null;
  acc.cplc = acc.adSpend > 0 ? moneyOrNull(acc.adSpend, acc.linkClicks) : null;
  acc.ctr = rateOrNull(acc.linkClicks, acc.impressions);
  acc.roas = acc.adSpend > 0 ? moneyOrNull(acc.successValue, acc.adSpend) : null;
  return acc;
}

/** Cost per appointment = spend / appts (not exposed directly by the view). */
function costPerAppt(t: CampaignWindowTotals): number | null {
  return t.adSpend > 0 ? moneyOrNull(t.adSpend, t.totalAppts) : null;
}

function pctChange(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

function buildMetric(
  key: string,
  label: string,
  kind: MetricComparison["kind"],
  current: number | null,
  prior: number | null,
  higherIsBetter: boolean
): MetricComparison {
  const deltaAbs =
    current != null && prior != null
      ? Math.round((current - prior) * 100) / 100
      : null;
  const deltaPct = pctChange(current, prior);
  let direction: MetricComparison["direction"] = null;
  let better: boolean | null = null;
  if (deltaAbs != null) {
    if (deltaAbs === 0) {
      direction = "flat";
      better = null;
    } else {
      direction = deltaAbs > 0 ? "up" : "down";
      better = deltaAbs > 0 ? higherIsBetter : !higherIsBetter;
    }
  }
  return { key, label, kind, current, prior, deltaAbs, deltaPct, higherIsBetter, direction, better };
}

function fmtMoney(v: number | null): string {
  if (v == null) return "n/a";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtRate(v: number | null): string {
  return v == null ? "n/a" : `${v}%`;
}

function fmtCount(v: number | null): string {
  return v == null ? "n/a" : String(v);
}

function presetToDescriptor(preset: AnalysisPreset) {
  const range = getDateRangeForPreset(preset as DateRangePreset);
  const label = DATE_RANGE_LABELS[preset as DateRangePreset] ?? preset;
  return { preset, label, startDate: range.startDate, endDate: range.endDate };
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.round(((Date.now() - then) / (1000 * 60 * 60)) * 10) / 10;
}

/**
 * Run the full diagnostic for the best client match of `query` over `preset`
 * (default last_30 days). Returns structured metrics plus plain-English
 * findings, or a not_found / ambiguous / no_snapshot status.
 */
export async function analyzeClientPerformance(params: {
  query: string;
  preset?: AnalysisPreset;
}): Promise<AnalyzeResult> {
  const preset = params.preset ?? "last_30";

  const resolved = await resolveSingleClient(params.query);
  if (resolved.status === "not_found") {
    return { status: "not_found", query: params.query };
  }
  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: resolved.matches.map((m) => ({
        locationId: m.locationId,
        businessName: m.businessName,
      })),
    };
  }

  const client: ResolvedClient = resolved.client;
  const descriptor = presetToDescriptor(preset);

  const view = await buildAgencyRollupView({
    onTotals: true,
    range: descriptor,
  });
  if (!view) return { status: "no_snapshot" };

  const keySet = new Set(client.campaignKeys);
  const campaigns = view.campaigns.filter(
    (c) => keySet.has(c.campaignKey) || c.locationId === client.locationId
  );
  const included = campaigns.filter((c) => c.included);

  const current = combineTotals(included.map((c) => c.totals));
  const prior = combineTotals(included.map((c) => c.priorTotals));
  const noData = included.length === 0;

  const metrics: MetricComparison[] = [
    buildMetric("metaLeads", "Leads", "count", current.metaLeads, prior.metaLeads, true),
    buildMetric("leads", "Leads (CRM)", "count", current.leads, prior.leads, true),
    buildMetric("appointments", "Appointments", "count", current.totalAppts, prior.totalAppts, true),
    buildMetric("showed", "Showed", "count", current.showed, prior.showed, true),
    buildMetric("closed", "Closed", "count", current.closed, prior.closed, true),
    buildMetric("adSpend", "Ad spend", "money", round2(current.adSpend), round2(prior.adSpend), false),
    buildMetric("cpl", "Cost per lead", "money", current.cpl, prior.cpl, false),
    buildMetric("costPerAppt", "Cost per appointment", "money", costPerAppt(current), costPerAppt(prior), false),
    buildMetric("cps", "Cost per show", "money", current.cps, prior.cps, false),
    buildMetric("cpClose", "Cost per close", "money", current.cpClose, prior.cpClose, false),
    buildMetric("bookingRate", "Booking rate", "rate", current.bookingRate, prior.bookingRate, true),
    buildMetric("showRate", "Show rate", "rate", current.showRate, prior.showRate, true),
    buildMetric("closeRate", "Close rate", "rate", current.closeRate, prior.closeRate, true),
    buildMetric("ctr", "Link CTR", "rate", current.ctr, prior.ctr, true),
    buildMetric("roas", "ROAS", "ratio", current.roas, prior.roas, true),
  ];

  const findings = buildFindings({ current, prior, metrics, noData });

  // Data quality: take the worst (max stale) campaign as the location signal.
  const dq = pickWorstDataQuality(included);
  const dqFindings = buildDataQualityFindings(dq, current);
  findings.push(...dqFindings);

  return {
    status: "ok",
    client: {
      locationId: client.locationId,
      businessName: client.businessName,
      ownerName: client.ownerName,
      cid: client.cid,
      adAccountIds: client.adAccountIds,
    },
    alternatives: resolved.alternatives.map((a) => ({
      locationId: a.locationId,
      businessName: a.businessName,
    })),
    window: descriptor,
    priorWindow: { startDate: view.priorRange.startDate, endDate: view.priorRange.endDate },
    snapshot: {
      id: view.snapshot.id,
      finishedAt: view.snapshot.finishedAt,
      ageHours: hoursSince(view.snapshot.finishedAt),
    },
    noData,
    metrics,
    findings,
    dataQuality: {
      openCount: dq.openCount,
      staleOpenCount: dq.staleOpenCount,
      staleOpenPct: dq.staleOpenPct,
      lastBoardMovementAt: dq.lastManualStageChangeAt,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function metricByKey(metrics: MetricComparison[], key: string): MetricComparison | undefined {
  return metrics.find((m) => m.key === key);
}

function dirWord(m: MetricComparison): string {
  return m.direction === "up" ? "up" : m.direction === "down" ? "down" : "flat";
}

/** Build the headline + notable-move findings from the metric table. */
function buildFindings(args: {
  current: CampaignWindowTotals;
  prior: CampaignWindowTotals;
  metrics: MetricComparison[];
  noData: boolean;
}): string[] {
  const { current, metrics, noData } = args;
  const out: string[] = [];

  if (noData) {
    out.push(
      "No campaign data ran for this client in the latest snapshot. They may be newly onboarded, paused, or pending setup."
    );
    return out;
  }

  // Lead flow is the headline for most support tickets (Meta = source of truth).
  const leads = metricByKey(metrics, "metaLeads")!;
  if (current.metaLeads === 0) {
    out.push("No Meta-attributed leads in this window. Check that ads are active and lead capture is firing.");
  } else if (leads.deltaPct != null) {
    out.push(
      `Leads ${dirWord(leads)} ${Math.abs(leads.deltaPct)}% this window (${fmtCount(leads.current)} vs ${fmtCount(leads.prior)} prior).`
    );
  } else {
    out.push(`Leads this window: ${fmtCount(leads.current)} (no prior period to compare).`);
  }

  // Cost per lead trend.
  const cpl = metricByKey(metrics, "cpl")!;
  if (cpl.current != null) {
    if (cpl.deltaPct != null) {
      out.push(
        `Cost per lead ${dirWord(cpl)} ${Math.abs(cpl.deltaPct)}% to ${fmtMoney(cpl.current)} (was ${fmtMoney(cpl.prior)}).`
      );
    } else {
      out.push(`Cost per lead is ${fmtMoney(cpl.current)}.`);
    }
  }

  // Lead-source reconciliation: GHL pipeline leads vs Meta's own attributed
  // leads. They never match exactly (attribution window, timezone, non-Meta
  // sources), so only call out a gap worth investigating.
  out.push(...buildLeadSourceFindings(current));

  // Booking and show rates are the usual "leads aren't converting" levers.
  for (const key of ["bookingRate", "showRate", "closeRate"] as const) {
    const m = metricByKey(metrics, key)!;
    if (m.current == null) continue;
    if (m.deltaAbs != null && Math.abs(m.deltaAbs) >= 3) {
      out.push(
        `${m.label} ${dirWord(m)} to ${fmtRate(m.current)} from ${fmtRate(m.prior)} (${m.better ? "improving" : "worse"}).`
      );
    }
  }

  // Spend swing worth calling out.
  const spend = metricByKey(metrics, "adSpend")!;
  if (spend.deltaPct != null && Math.abs(spend.deltaPct) >= 20) {
    out.push(
      `Ad spend ${dirWord(spend)} ${Math.abs(spend.deltaPct)}% to ${fmtMoney(spend.current)} (was ${fmtMoney(spend.prior)}).`
    );
  }

  // Appointments / closes summary line.
  const appts = metricByKey(metrics, "appointments")!;
  const closed = metricByKey(metrics, "closed")!;
  out.push(
    `Funnel this window: ${fmtCount(leads.current)} leads → ${fmtCount(appts.current)} appointments → ${fmtCount(metricByKey(metrics, "showed")!.current)} showed → ${fmtCount(closed.current)} closed.`
  );

  return out;
}

/**
 * Compare GHL pipeline leads to Meta's own attributed lead count and flag a
 * gap worth investigating. The two sources measure different things, so this
 * uses a tolerance band (absolute AND relative) rather than exact equality,
 * and frames the finding by direction:
 *   - Meta > CRM: Meta paid for leads that never landed in GHL (sync gap).
 *   - CRM > Meta: leads in GHL that Meta didn't attribute (non-Meta sources,
 *     or Meta pixel/CAPI isn't tagging ad-driven leads).
 */
function buildLeadSourceFindings(current: CampaignWindowTotals): string[] {
  const crm = current.leads;
  const meta = current.metaLeads;
  if (meta === 0 && crm === 0) return [];
  if (crm === meta) {
    return [`CRM and Meta agree: ${crm} leads.`];
  }
  if (meta > crm) {
    return [
      `Meta counted ${meta} paid leads; ${crm} reached the CRM. Check lead-form sync, pipeline stage mapping, and tag filter.`,
    ];
  }
  return [
    `CRM has ${crm} leads; Meta attributed ${meta}. Extra CRM leads are usually organic/referral or missing pixel/CAPI tagging.`,
  ];
}

interface WorstDq {
  openCount: number | null;
  staleOpenCount: number | null;
  staleOpenPct: number | null;
  lastManualStageChangeAt: string | null;
  movementRatio: number | null;
}

function pickWorstDataQuality(campaigns: CampaignSummary[]): WorstDq {
  const out: WorstDq = {
    openCount: null,
    staleOpenCount: null,
    staleOpenPct: null,
    lastManualStageChangeAt: null,
    movementRatio: null,
  };
  for (const c of campaigns) {
    const dq = c.dataQuality;
    if (dq.openCount != null) out.openCount = (out.openCount ?? 0) + dq.openCount;
    if (dq.staleOpenCount != null) out.staleOpenCount = (out.staleOpenCount ?? 0) + dq.staleOpenCount;
    if (dq.movementRatio != null) {
      out.movementRatio = out.movementRatio == null ? dq.movementRatio : Math.min(out.movementRatio, dq.movementRatio);
    }
    if (dq.lastManualStageChangeAt) {
      if (!out.lastManualStageChangeAt || dq.lastManualStageChangeAt > out.lastManualStageChangeAt) {
        out.lastManualStageChangeAt = dq.lastManualStageChangeAt;
      }
    }
  }
  if (out.openCount != null && out.openCount > 0 && out.staleOpenCount != null) {
    out.staleOpenPct = Math.round((out.staleOpenCount / out.openCount) * 1000) / 10;
  }
  return out;
}

/**
 * Findings that explain "the leads aren't showing up" tickets: leads captured
 * but not worked. Stale open opps and a cold board are the usual culprits.
 */
function buildDataQualityFindings(dq: WorstDq, current: CampaignWindowTotals): string[] {
  const out: string[] = [];
  if (dq.staleOpenCount != null && dq.staleOpenCount > 0) {
    const pct = dq.staleOpenPct != null ? ` (${dq.staleOpenPct}% of open)` : "";
    out.push(
      `${dq.staleOpenCount} open opportunities have sat untouched for 21+ days${pct}. Leads may be arriving but not being worked or marked in the pipeline.`
    );
  }
  if (dq.lastManualStageChangeAt) {
    const ageDays = Math.round(
      (Date.now() - new Date(dq.lastManualStageChangeAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (ageDays >= 5) {
      out.push(
        `The pipeline board hasn't been manually updated in ${ageDays} days, so stage counts (shows/closes) may lag reality.`
      );
    }
  }
  if (current.leads > 0 && current.totalAppts === 0) {
    out.push(
      "Leads are coming in but none reached the appointment stage. This points to follow-up/booking, not ad volume."
    );
  }
  return out;
}
