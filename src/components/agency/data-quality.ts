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
  leads: number;
  totalAppts: number;
  showed: number;
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
 * Re-aggregate a specific month-window from a subset of campaigns. Used by
 * the KPI cards: sums include every campaign so "total Leads / Appts /
 * Closed" stays meaningful, but rates/cost-efficiency use only campaigns
 * whose data we trust.
 */
export function aggregateCampaignsOverMonths(
  campaigns: ClientCampaignSummary[],
  monthKeys: string[]
): FilteredAggregate {
  const totals = {
    leads: 0,
    totalAppts: 0,
    showed: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
  };
  for (const c of campaigns) {
    for (const m of c.months) {
      if (!monthKeys.includes(m.monthKey)) continue;
      accumulate(totals, m);
    }
  }
  const leadPool =
    totals.leads + totals.totalAppts + totals.showed + totals.closed;
  const apptPool = totals.totalAppts + totals.showed + totals.closed;
  const showPool = totals.showed + totals.closed;
  return {
    monthsCount: monthKeys.length,
    ...totals,
    bookingRate:
      leadPool > 0
        ? Math.round((apptPool / leadPool) * 1000) / 10
        : null,
    showRate:
      apptPool > 0 ? Math.round((showPool / apptPool) * 1000) / 10 : null,
    closeRate:
      showPool > 0 ? Math.round((totals.closed / showPool) * 1000) / 10 : null,
    cpl:
      totals.adSpend > 0 && totals.leads > 0
        ? Math.round((totals.adSpend / totals.leads) * 100) / 100
        : null,
    cps:
      totals.adSpend > 0 && totals.showed > 0
        ? Math.round((totals.adSpend / totals.showed) * 100) / 100
        : null,
    cpClose:
      totals.adSpend > 0 && totals.closed > 0
        ? Math.round((totals.adSpend / totals.closed) * 100) / 100
        : null,
    roas:
      totals.adSpend > 0
        ? Math.round((totals.successValue / totals.adSpend) * 100) / 100
        : null,
  };
}

function accumulate(
  totals: {
    leads: number;
    totalAppts: number;
    showed: number;
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
  totals.closed += m.closed;
  totals.totalValue += m.totalValue;
  totals.successValue += m.successValue;
  totals.adSpend += m.adSpend;
}
