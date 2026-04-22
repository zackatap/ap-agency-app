/**
 * Data-hygiene filter: detect campaigns whose opportunity board hasn't been
 * kept up to date and optionally exclude them from agency averages/rates.
 *
 * Approach
 * --------
 * We combine two independent signals (both pre-computed server-side during
 * the rollup refresh):
 *
 *   1. movementRatio (0..1): of every appointment that reached Requested or
 *      later, what fraction moved to a manual stage (showed/noShow/closed)?
 *      Low ⇒ automations flow appts in, human never moves them forward. We
 *      compute this over the "aged" window (excluding the last ~14 days)
 *      to avoid penalising legitimately in-flight appointments.
 *
 *   2. staleOpenPct (0..1): of opps CURRENTLY sitting in Requested or
 *      Confirmed with status=open, what fraction haven't had their stage
 *      touched in >21 days? High ⇒ a pile of abandoned old appointments.
 *      This is a real-time snapshot, not historical.
 *
 * We also require a minimum of MIN_APPTS total appointments across the
 * window before we'll flag a campaign — brand new clients with 2 appts
 * shouldn't be excluded just because nothing has moved yet.
 *
 * Policy (all-or-nothing exclusion — if a campaign is flagged, it's excluded
 * from every rate/average, not just the ones it looks bad on):
 *
 *   - off:        never exclude. Signals still shown as context.
 *   - light:      only exclude clients who clearly aren't updating at all.
 *   - moderate:   recommended default. Catches obvious cases without being
 *                 too aggressive.
 *   - aggressive: catches borderline cases too.
 */

import type {
  ClientCampaignSummary,
  ClientCampaignMonth,
} from "./types";

export const EXCLUSION_LEVELS = ["off", "light", "moderate", "aggressive"] as const;
export type ExclusionLevel = (typeof EXCLUSION_LEVELS)[number];

/**
 * Minimum lifetime appointments before we'll consider flagging. Avoids
 * excluding brand-new campaigns that simply haven't had time to move
 * anything forward yet.
 */
const MIN_APPTS = 5;

/** Minimum open-stage backlog before staleOpenPct becomes meaningful. */
const MIN_OPEN_FOR_STALE = 5;

interface ExclusionRule {
  movementBelow?: number;
  staleOpenAbove?: number;
}

/**
 * Rules are disjunctive: a campaign is flagged if ANY applicable signal
 * crosses its threshold. `null` signals never match (treat as "not enough
 * data to judge").
 */
const EXCLUSION_RULES: Record<ExclusionLevel, ExclusionRule | null> = {
  off: null,
  light: {
    movementBelow: 0.05,
    staleOpenAbove: 0.8,
  },
  moderate: {
    movementBelow: 0.25,
    staleOpenAbove: 0.5,
  },
  aggressive: {
    movementBelow: 0.5,
    staleOpenAbove: 0.3,
  },
};

export interface ExclusionVerdict {
  excluded: boolean;
  /** Human-readable reason for inclusion panels / tooltips. */
  reason: string | null;
}

export function evaluateExclusion(
  campaign: ClientCampaignSummary,
  level: ExclusionLevel
): ExclusionVerdict {
  if (level === "off") return { excluded: false, reason: null };
  const rule = EXCLUSION_RULES[level];
  if (!rule) return { excluded: false, reason: null };

  const q = campaign.dataQuality;
  if (!q) return { excluded: false, reason: null };

  const totalAppts =
    campaign.totals.totalAppts +
    campaign.totals.showed +
    campaign.totals.closed;
  if (totalAppts < MIN_APPTS) return { excluded: false, reason: null };

  const reasons: string[] = [];

  if (
    rule.movementBelow != null &&
    q.movementRatio != null &&
    q.movementRatio < rule.movementBelow
  ) {
    reasons.push(
      `only ${Math.round(q.movementRatio * 100)}% of appts moved past the automated stages`
    );
  }

  if (
    rule.staleOpenAbove != null &&
    q.staleOpenPct != null &&
    q.openCount != null &&
    q.openCount >= MIN_OPEN_FOR_STALE &&
    q.staleOpenPct > rule.staleOpenAbove
  ) {
    reasons.push(
      `${q.staleOpenCount}/${q.openCount} open opps have been untouched >21 days`
    );
  }

  if (reasons.length === 0) return { excluded: false, reason: null };
  return { excluded: true, reason: reasons.join("; ") };
}

export function buildExcludedSet(
  campaigns: ClientCampaignSummary[],
  level: ExclusionLevel
): Map<string, ExclusionVerdict> {
  const map = new Map<string, ExclusionVerdict>();
  if (level === "off") return map;
  for (const c of campaigns) {
    const v = evaluateExclusion(c, level);
    if (v.excluded) map.set(c.campaignKey, v);
  }
  return map;
}

export interface FilteredAggregate {
  /** Number of months the window covers. */
  monthsCount: number;
  /** Number of campaigns that contributed non-zero data to the rate averages. */
  contributingCampaigns: number;
  leads: number;
  totalAppts: number;
  showed: number;
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
  bookingRate: number | null;
  showRate: number | null;
  closeRate: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
  roas: number | null;
}

/**
 * Re-aggregate a specific month-window from a subset of campaigns for the
 * KPI cards.
 *
 *   - Sums (leads, appts, showed, closed, adSpend, value) are pooled totals
 *     across every contributing campaign so "total Leads" still means what
 *     it says.
 *   - Rates and cost ratios use a **simple (unweighted) average across
 *     campaigns**: each campaign computes its own window-level rate from
 *     its own counts, then we average those rates. Every client gets one
 *     vote regardless of size — a 3,000-lead client doesn't drown out a
 *     300-lead client. This matches the benchmark chart's agency avg line
 *     and the individual dashboard's per-client rate.
 *
 * A campaign only contributes to a rate when its denominator is positive
 * (e.g. a campaign with zero leads doesn't vote on booking rate — it has no
 * opinion, not a "0%" opinion).
 */
export function aggregateCampaignsOverMonths(
  campaigns: ClientCampaignSummary[],
  monthKeys: string[]
): FilteredAggregate {
  const monthSet = new Set(monthKeys);
  const totals = {
    leads: 0,
    totalAppts: 0,
    showed: 0,
    noShow: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
  };

  // Per-campaign rate samples. Null entries are intentionally omitted so
  // they don't drag the average down — no denominator = no vote.
  const bookingSamples: number[] = [];
  const showSamples: number[] = [];
  const closeSamples: number[] = [];
  const cplSamples: number[] = [];
  const cpsSamples: number[] = [];
  const cpCloseSamples: number[] = [];
  const roasSamples: number[] = [];
  let contributingCampaigns = 0;

  for (const c of campaigns) {
    const perCampaign = {
      leads: 0,
      totalAppts: 0,
      showed: 0,
      noShow: 0,
      closed: 0,
      totalValue: 0,
      successValue: 0,
      adSpend: 0,
    };
    let hasAnyMonth = false;
    for (const m of c.months) {
      if (!monthSet.has(m.monthKey)) continue;
      hasAnyMonth = true;
      accumulate(perCampaign, m);
    }
    if (!hasAnyMonth) continue;

    // Fold per-campaign totals into the agency-wide sums.
    totals.leads += perCampaign.leads;
    totals.totalAppts += perCampaign.totalAppts;
    totals.showed += perCampaign.showed;
    totals.noShow += perCampaign.noShow;
    totals.closed += perCampaign.closed;
    totals.totalValue += perCampaign.totalValue;
    totals.successValue += perCampaign.successValue;
    totals.adSpend += perCampaign.adSpend;

    // Compute this campaign's window-level rates. No-shows count as booked
    // but not showed — matches applyRollup in funnel-metrics.ts.
    const apptPool =
      perCampaign.totalAppts +
      perCampaign.showed +
      perCampaign.noShow +
      perCampaign.closed;
    const leadPool = perCampaign.leads + apptPool;
    const showPool = perCampaign.showed + perCampaign.closed;

    let voted = false;
    if (leadPool > 0) {
      bookingSamples.push((apptPool / leadPool) * 100);
      voted = true;
    }
    if (apptPool > 0) {
      showSamples.push(((perCampaign.showed + perCampaign.closed) / apptPool) * 100);
      voted = true;
    }
    if (showPool > 0) {
      closeSamples.push((perCampaign.closed / showPool) * 100);
      voted = true;
    }
    if (perCampaign.adSpend > 0 && perCampaign.leads > 0) {
      cplSamples.push(perCampaign.adSpend / perCampaign.leads);
      voted = true;
    }
    if (perCampaign.adSpend > 0 && perCampaign.showed > 0) {
      cpsSamples.push(perCampaign.adSpend / perCampaign.showed);
      voted = true;
    }
    if (perCampaign.adSpend > 0 && perCampaign.closed > 0) {
      cpCloseSamples.push(perCampaign.adSpend / perCampaign.closed);
      voted = true;
    }
    if (perCampaign.adSpend > 0) {
      roasSamples.push(perCampaign.successValue / perCampaign.adSpend);
      voted = true;
    }
    if (voted) contributingCampaigns += 1;
  }

  return {
    monthsCount: monthKeys.length,
    contributingCampaigns,
    ...totals,
    bookingRate: roundAvg(bookingSamples, 1),
    showRate: roundAvg(showSamples, 1),
    closeRate: roundAvg(closeSamples, 1),
    cpl: roundAvg(cplSamples, 2),
    cps: roundAvg(cpsSamples, 2),
    cpClose: roundAvg(cpCloseSamples, 2),
    roas: roundAvg(roasSamples, 2),
  };
}

/**
 * Simple (unweighted) mean of the sample list, rounded to `decimals` places.
 * Returns null for empty lists so the KPI card shows "—" instead of "0%".
 */
function roundAvg(samples: number[], decimals: number): number | null {
  if (samples.length === 0) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const scale = Math.pow(10, decimals);
  return Math.round(mean * scale) / scale;
}

function accumulate(
  totals: {
    leads: number;
    totalAppts: number;
    showed: number;
    noShow: number;
    closed: number;
    totalValue: number;
    successValue: number;
    adSpend: number;
  },
  m: ClientCampaignMonth
): void {
  totals.leads += m.leads;
  totals.totalAppts += m.totalAppts;
  totals.showed += m.showed;
  totals.noShow += m.noShow;
  totals.closed += m.closed;
  totals.totalValue += m.totalValue;
  totals.successValue += m.successValue;
  totals.adSpend += m.adSpend;
}
