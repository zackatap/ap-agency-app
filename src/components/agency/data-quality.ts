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
  ClientCampaignWindowTotals,
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

/** Unique opps that reached the appointment funnel (not double-counted). */
function appointmentReach(
  t: ClientCampaignSummary["totals"],
  onTotals: boolean
): number {
  if (onTotals) {
    // totalAppts is already r+c+s+n+cl
    return t.totalAppts;
  }
  return t.totalAppts + t.showed + t.noShow + t.closed;
}

export function evaluateExclusion(
  campaign: ClientCampaignSummary,
  level: ExclusionLevel,
  onTotals: boolean
): ExclusionVerdict {
  if (level === "off") return { excluded: false, reason: null };
  const rule = EXCLUSION_RULES[level];
  if (!rule) return { excluded: false, reason: null };

  const q = campaign.dataQuality;
  if (!q) return { excluded: false, reason: null };

  if (appointmentReach(campaign.totals, onTotals) < MIN_APPTS) {
    return { excluded: false, reason: null };
  }

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
  level: ExclusionLevel,
  onTotals: boolean
): Map<string, ExclusionVerdict> {
  const map = new Map<string, ExclusionVerdict>();
  if (level === "off") return map;
  for (const c of campaigns) {
    const v = evaluateExclusion(c, level, onTotals);
    if (v.excluded) map.set(c.campaignKey, v);
  }
  return map;
}

export interface FilteredAggregate {
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

type TotalsKey = "totals" | "priorTotals";

/**
 * Aggregate window totals across a subset of campaigns for the KPI cards.
 *
 *   - Sums (leads, appts, showed, closed, adSpend, value) are pooled totals
 *     across every campaign in the list so "total Leads" still means what
 *     it says.
 *   - Rates and cost ratios use a **simple (unweighted) average across
 *     campaigns**: the server has already computed each campaign's rate
 *     over the exact date range, and we just average those values. Every
 *     client gets one vote regardless of size — a 3,000-lead client
 *     doesn't drown out a 300-lead client.
 *
 * Only rates with a non-null value (i.e. the campaign had a non-zero
 * denominator over the window) contribute — a campaign with zero leads
 * doesn't vote on booking rate.
 */
export function aggregateCampaignWindow(
  campaigns: ClientCampaignSummary[],
  which: TotalsKey = "totals"
): FilteredAggregate {
  const sums = {
    leads: 0,
    totalAppts: 0,
    showed: 0,
    noShow: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
  };
  const bookingSamples: number[] = [];
  const showSamples: number[] = [];
  const closeSamples: number[] = [];
  const cplSamples: number[] = [];
  const cpsSamples: number[] = [];
  const cpCloseSamples: number[] = [];
  const roasSamples: number[] = [];
  let contributingCampaigns = 0;

  for (const c of campaigns) {
    const t: ClientCampaignWindowTotals = c[which];
    if (!t) continue;
    sums.leads += t.leads;
    sums.totalAppts += t.totalAppts;
    sums.showed += t.showed;
    sums.noShow += t.noShow;
    sums.closed += t.closed;
    sums.totalValue += t.totalValue;
    sums.successValue += t.successValue;
    sums.adSpend += t.adSpend;

    let voted = false;
    if (t.bookingRate != null) {
      bookingSamples.push(t.bookingRate);
      voted = true;
    }
    if (t.showRate != null) {
      showSamples.push(t.showRate);
      voted = true;
    }
    if (t.closeRate != null) {
      closeSamples.push(t.closeRate);
      voted = true;
    }
    if (t.cpl != null) {
      cplSamples.push(t.cpl);
      voted = true;
    }
    if (t.cps != null) {
      cpsSamples.push(t.cps);
      voted = true;
    }
    if (t.cpClose != null) {
      cpCloseSamples.push(t.cpClose);
      voted = true;
    }
    if (t.roas != null) {
      roasSamples.push(t.roas);
      voted = true;
    }
    if (voted) contributingCampaigns += 1;
  }

  return {
    contributingCampaigns,
    ...sums,
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
