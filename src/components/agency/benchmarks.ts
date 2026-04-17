import type {
  ClientCampaignMonth,
  ClientCampaignSummary,
  ClientLeaderboardRow,
  CampaignStatusLabel,
  MetricKey,
} from "./types";
import { METRIC_META } from "./metric-meta";

function getValue(
  month: ClientCampaignMonth | null | undefined,
  metric: MetricKey
): number | null {
  if (!month) return null;
  const v = (month as unknown as Record<string, number | null>)[metric];
  return v == null ? null : Number(v);
}

export function getCampaignMetric(
  campaign: ClientCampaignSummary,
  metric: MetricKey,
  monthKey: string | "total"
): number | null {
  if (monthKey === "total") {
    const source = {
      monthKey: "",
      ...campaign.totals,
    } as unknown as ClientCampaignMonth;
    return getValue(source, metric);
  }
  const monthly = campaign.months.find((m) => m.monthKey === monthKey);
  return getValue(monthly, metric);
}

/** Same as {@link getCampaignMetric} but for a row-shaped aggregation. */
export function getRowMetric(
  row: ClientLeaderboardRow,
  metric: MetricKey,
  monthKey: string | "total"
): number | null {
  if (monthKey === "total") {
    const source = {
      monthKey: "",
      ...row.totals,
    } as unknown as ClientCampaignMonth;
    return getValue(source, metric);
  }
  const monthly = row.months.find((m) => m.monthKey === monthKey);
  return getValue(monthly, metric);
}

export interface Distribution {
  values: Array<{ key: string; value: number }>;
  simpleAverage: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  p25: number | null;
  p75: number | null;
}

function percentileValue(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function buildDistribution(
  campaigns: ClientCampaignSummary[],
  metric: MetricKey,
  monthKey: string | "total"
): Distribution {
  const values = campaigns
    .filter((c) => c.included)
    .map((c) => ({
      key: c.campaignKey,
      value: getCampaignMetric(c, metric, monthKey),
    }))
    .filter((v): v is { key: string; value: number } => v.value != null);

  const sorted = values.map((v) => v.value).sort((a, b) => a - b);
  const simpleAverage =
    sorted.length > 0
      ? sorted.reduce((a, b) => a + b, 0) / sorted.length
      : null;

  return {
    values,
    simpleAverage,
    median: percentileValue(sorted, 0.5),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    p25: percentileValue(sorted, 0.25),
    p75: percentileValue(sorted, 0.75),
  };
}

export interface Rank {
  rank: number;
  of: number;
  percentile: number;
}

/**
 * Percentile = % of other entries that a lower metric beats (or ties) us on,
 * inverted when `higherIsBetter=false` so "95th percentile" always means "best".
 */
export function computeRank(
  dist: Distribution,
  key: string,
  metric: MetricKey
): Rank | null {
  const meta = METRIC_META[metric];
  const entries = dist.values.slice();
  entries.sort((a, b) =>
    meta.higherIsBetter ? b.value - a.value : a.value - b.value
  );
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return null;
  const rank = idx + 1;
  const of = entries.length;
  const percentile =
    of <= 1 ? 100 : Math.round(((of - rank) / (of - 1)) * 100);
  return { rank, of, percentile };
}

/**
 * Combine a set of campaigns into a single aggregated row (used for CID
 * rollups and location rollups).
 */
export function aggregateCampaigns(
  campaigns: ClientCampaignSummary[]
): Pick<ClientLeaderboardRow, "totals" | "months"> {
  if (campaigns.length === 0) {
    return {
      totals: emptyTotals(),
      months: [],
    };
  }
  const monthKeys = campaigns[0].months.map((m) => m.monthKey);
  const months: ClientCampaignMonth[] = monthKeys.map((mk) => {
    let leads = 0,
      totalAppts = 0,
      showed = 0,
      closed = 0,
      totalValue = 0,
      successValue = 0,
      adSpend = 0;
    for (const c of campaigns) {
      const m = c.months.find((mm) => mm.monthKey === mk);
      if (!m) continue;
      leads += m.leads;
      totalAppts += m.totalAppts;
      showed += m.showed;
      closed += m.closed;
      totalValue += m.totalValue;
      successValue += m.successValue;
      adSpend += m.adSpend;
    }
    return buildMonthRow(mk, leads, totalAppts, showed, closed, totalValue, successValue, adSpend);
  });
  const total = sumMonthRows(months);
  return { totals: total, months };
}

function buildMonthRow(
  monthKey: string,
  leads: number,
  totalAppts: number,
  showed: number,
  closed: number,
  totalValue: number,
  successValue: number,
  adSpend: number
): ClientCampaignMonth {
  const pool = leads + totalAppts + showed + closed;
  const bookingRate =
    pool > 0
      ? Math.round(((totalAppts + showed + closed) / pool) * 1000) / 10
      : null;
  const apptPool = totalAppts + showed + closed;
  const showRate =
    apptPool > 0
      ? Math.round(((showed + closed) / apptPool) * 1000) / 10
      : null;
  const closePool = showed + closed;
  const closeRate =
    closePool > 0 ? Math.round((closed / closePool) * 1000) / 10 : null;
  return {
    monthKey,
    leads,
    totalAppts,
    showed,
    closed,
    totalValue,
    successValue,
    adSpend,
    bookingRate,
    showRate,
    closeRate,
    cpl:
      adSpend > 0 && leads > 0 ? Math.round((adSpend / leads) * 100) / 100 : null,
    cps:
      adSpend > 0 && showed > 0 ? Math.round((adSpend / showed) * 100) / 100 : null,
    cpClose:
      adSpend > 0 && closed > 0 ? Math.round((adSpend / closed) * 100) / 100 : null,
    roas:
      adSpend > 0 ? Math.round((successValue / adSpend) * 100) / 100 : null,
  };
}

function sumMonthRows(
  months: ClientCampaignMonth[]
): Omit<ClientCampaignMonth, "monthKey"> {
  const totals = months.reduce(
    (acc, m) => {
      acc.leads += m.leads;
      acc.totalAppts += m.totalAppts;
      acc.showed += m.showed;
      acc.closed += m.closed;
      acc.totalValue += m.totalValue;
      acc.successValue += m.successValue;
      acc.adSpend += m.adSpend;
      return acc;
    },
    {
      leads: 0,
      totalAppts: 0,
      showed: 0,
      closed: 0,
      totalValue: 0,
      successValue: 0,
      adSpend: 0,
    }
  );
  const row = buildMonthRow(
    "",
    totals.leads,
    totals.totalAppts,
    totals.showed,
    totals.closed,
    totals.totalValue,
    totals.successValue,
    totals.adSpend
  );
  // strip monthKey
  const { monthKey: _mk, ...rest } = row;
  void _mk;
  return rest;
}

function emptyTotals(): Omit<ClientCampaignMonth, "monthKey"> {
  return {
    leads: 0,
    totalAppts: 0,
    showed: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
    bookingRate: null,
    showRate: null,
    closeRate: null,
    cpl: null,
    cps: null,
    cpClose: null,
    roas: null,
  };
}

/**
 * Turn a flat list of campaigns into leaderboard rows. CID rollups combine
 * every campaign sharing a CID into a single parent row with `children`
 * populated for the accordion expand. Campaigns with no CID appear as
 * standalone rows.
 */
export function buildLeaderboardRows(
  campaigns: ClientCampaignSummary[],
  mode: "campaign" | "cid" = "cid"
): ClientLeaderboardRow[] {
  if (mode === "campaign") {
    return campaigns.map(campaignToRow);
  }

  const byCid = new Map<string, ClientCampaignSummary[]>();
  const standalone: ClientCampaignSummary[] = [];
  for (const c of campaigns) {
    const cid = c.cid?.trim();
    if (!cid) {
      standalone.push(c);
      continue;
    }
    const list = byCid.get(cid) ?? [];
    list.push(c);
    byCid.set(cid, list);
  }

  const rows: ClientLeaderboardRow[] = [];
  for (const [cid, group] of byCid.entries()) {
    if (group.length === 1) {
      rows.push(campaignToRow(group[0]));
      continue;
    }
    const agg = aggregateCampaigns(group);
    const first = group[0];
    const statusSet = new Set<CampaignStatusLabel>();
    for (const g of group) statusSet.add(g.status);
    const statuses = Array.from(statusSet);
    const anyExcluded = group.some((g) => !g.included);
    rows.push({
      rowKey: `cid:${cid}`,
      isGroup: true,
      displayName: first.businessName,
      subLabel: `CID ${cid} · ${group.length} campaigns`,
      cid,
      locationId: null,
      campaignKey: null,
      pipelineName: null,
      statuses,
      included: !anyExcluded,
      errorMessage: anyExcluded
        ? group.find((g) => !g.included)?.errorMessage ?? null
        : null,
      totals: agg.totals,
      months: agg.months,
      children: [...group].sort((a, b) =>
        a.status === b.status ? 0 : a.status === "ACTIVE" ? -1 : 1
      ),
    });
  }
  for (const c of standalone) rows.push(campaignToRow(c));
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

function campaignToRow(c: ClientCampaignSummary): ClientLeaderboardRow {
  return {
    rowKey: `cmp:${c.campaignKey}`,
    isGroup: false,
    displayName: c.businessName,
    subLabel: c.ownerName,
    cid: c.cid,
    locationId: c.locationId,
    campaignKey: c.campaignKey,
    pipelineName: c.pipelineName,
    statuses: [c.status],
    included: c.included,
    errorMessage: c.errorMessage ?? c.needsSetupReason,
    totals: c.totals,
    months: c.months,
    children: [c],
  };
}

