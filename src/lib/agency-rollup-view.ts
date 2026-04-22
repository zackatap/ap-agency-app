/**
 * Builds the payload served to the agency dashboard from a stored snapshot.
 *
 * Grain: one entry per CAMPAIGN (a.k.a. per sheet row). A location with
 * ACTIVE + 2ND CMPN contributes two CampaignSummary objects. The UI decides
 * whether to display them grouped by CID (with an accordion) or flat.
 *
 * Averages policy:
 *   - "Simple average" = mean of each campaign's per-month rate. Each
 *     campaign counted once per month.
 *   - "Weighted average" = sum(numerator) / sum(denominator) across
 *     campaigns. Shown as context.
 */

import { getMonthsBack } from "@/lib/date-ranges";
import type { FunnelMetrics } from "@/lib/funnel-metrics";
import {
  getLatestCompleteSnapshot,
  getSnapshotById,
  listCampaigns,
  listSnapshotCampaignMonths,
  type AgencyCampaignRecord,
  type AgencyCampaignMonth,
  type AgencySnapshot,
} from "@/lib/agency-rollup-store";
import type { CampaignStatus } from "@/lib/agency-clients";

export type MetricKey =
  | "leads"
  | "totalAppts"
  | "showed"
  | "closed"
  | "totalValue"
  | "successValue"
  | "adSpend"
  | "bookingRate"
  | "showRate"
  | "closeRate"
  | "cpl"
  | "cps"
  | "cpClose"
  | "roas";

export interface MonthTotals {
  monthKey: string;
  startDate: string;
  endDate: string;
  leads: number;
  totalAppts: number;
  showed: number;
  /** Opps marked no-show. Counted as "booked" in booking rate, excluded from show-rate numerator. */
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
  clientCount: number;
  bookingRateSimple: number | null;
  bookingRateWeighted: number | null;
  showRateSimple: number | null;
  showRateWeighted: number | null;
  closeRateSimple: number | null;
  closeRateWeighted: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
  roas: number | null;
}

export interface CampaignMonthly {
  monthKey: string;
  leads: number;
  totalAppts: number;
  showed: number;
  /** Opps marked no-show. Counted as "booked" in booking rate, excluded from show-rate numerator. */
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

export interface CampaignDataQuality {
  /**
   * Fraction (0..1) of appointments that were moved out of the automated
   * Requested/Confirmed stages into a manual stage (showed/noShow/closed)
   * over the aged portion of the window. Low ⇒ the client is leaving
   * opportunities in the automated stages.
   */
  movementRatio: number | null;
  /** Current count of open opps sitting in automated stages. */
  openCount: number | null;
  /** Of `openCount`, how many haven't had a stage change in >21 days. */
  staleOpenCount: number | null;
  /** staleOpenCount / openCount when openCount > 0. */
  staleOpenPct: number | null;
  /**
   * Most recent timestamp at which any opp in a manual stage
   * (showed/noShow/closed) had its stage touched. ISO string.
   */
  lastManualStageChangeAt: string | null;
}

export interface CampaignSummary {
  /** `${locationId}:${pipelineKeywordOrStatus}` — unique across the agency. */
  campaignKey: string;
  locationId: string;
  status: CampaignStatus;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  adAccountId: string | null;
  included: boolean;
  /** When not included: "skipped" or "error" plus a reason. */
  errorMessage: string | null;
  needsSetupReason: string | null;
  dataQuality: CampaignDataQuality;
  totals: Omit<CampaignMonthly, "monthKey">;
  latestMonth: CampaignMonthly | null;
  months: CampaignMonthly[];
}

export interface AgencyRollupView {
  snapshot: AgencySnapshot;
  months: MonthTotals[];
  campaigns: CampaignSummary[];
}

interface MonthlyAccum {
  monthKey: string;
  startDate: string;
  endDate: string;
  leads: number;
  totalAppts: number;
  showed: number;
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
  clientCount: number;
  bookingRates: number[];
  showRates: number[];
  closeRates: number[];
}

function rateOrNull(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

function moneyOrNull(num: number, den: number): number | null {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 100) / 100;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

function buildCampaignMonth(
  monthKey: string,
  metrics: FunnelMetrics | null,
  adSpend: number
): CampaignMonthly {
  const leads = metrics?.leads ?? 0;
  const totalAppts = metrics?.totalAppts ?? 0;
  const showed = metrics?.showed ?? 0;
  const noShow = metrics?.noShow ?? 0;
  const closed = metrics?.closed ?? 0;
  const totalValue = metrics?.totalValue ?? 0;
  const successValue = metrics?.successValue ?? 0;

  /*
   * Match the individual dashboard's "On Totals" formula (applyRollup in
   * funnel-metrics.ts): everyone who reached an appointment stage — including
   * no-shows — counts as "booked" in the booking rate. No-shows sit in the
   * show-rate denominator (they booked) but NOT the numerator (they didn't
   * show). Close rate is unaffected.
   */
  const leadPool = leads + totalAppts + showed + noShow + closed;
  const bookedCount = totalAppts + showed + noShow + closed;
  const bookingRate = leadPool > 0 ? rateOrNull(bookedCount, leadPool) : null;
  const showRate =
    bookedCount > 0 ? rateOrNull(showed + closed, bookedCount) : null;
  const closeRate = rateOrNull(closed, showed + closed);

  return {
    monthKey,
    leads,
    totalAppts,
    showed,
    noShow,
    closed,
    totalValue,
    successValue,
    adSpend,
    bookingRate,
    showRate,
    closeRate,
    cpl: adSpend > 0 ? moneyOrNull(adSpend, leads) : null,
    cps: adSpend > 0 ? moneyOrNull(adSpend, showed) : null,
    cpClose: adSpend > 0 ? moneyOrNull(adSpend, closed) : null,
    roas: adSpend > 0 ? moneyOrNull(successValue, adSpend) : null,
  };
}

function sumCampaignMonthly(
  months: CampaignMonthly[]
): Omit<CampaignMonthly, "monthKey"> {
  const totals = months.reduce(
    (acc, m) => {
      acc.leads += m.leads;
      acc.totalAppts += m.totalAppts;
      acc.showed += m.showed;
      acc.noShow += m.noShow;
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
      noShow: 0,
      closed: 0,
      totalValue: 0,
      successValue: 0,
      adSpend: 0,
    }
  );
  const bookedCount =
    totals.totalAppts + totals.showed + totals.noShow + totals.closed;
  const leadPool = totals.leads + bookedCount;
  return {
    ...totals,
    bookingRate: leadPool > 0 ? rateOrNull(bookedCount, leadPool) : null,
    showRate:
      bookedCount > 0
        ? rateOrNull(totals.showed + totals.closed, bookedCount)
        : null,
    closeRate: rateOrNull(totals.closed, totals.showed + totals.closed),
    cpl: totals.adSpend > 0 ? moneyOrNull(totals.adSpend, totals.leads) : null,
    cps: totals.adSpend > 0 ? moneyOrNull(totals.adSpend, totals.showed) : null,
    cpClose:
      totals.adSpend > 0 ? moneyOrNull(totals.adSpend, totals.closed) : null,
    roas:
      totals.adSpend > 0 ? moneyOrNull(totals.successValue, totals.adSpend) : null,
  };
}

function extractDataQuality(
  record: AgencyCampaignRecord | undefined
): CampaignDataQuality {
  if (!record) {
    return {
      movementRatio: null,
      openCount: null,
      staleOpenCount: null,
      staleOpenPct: null,
      lastManualStageChangeAt: null,
    };
  }
  return {
    movementRatio: record.movementRatio,
    openCount: record.openCount,
    staleOpenCount: record.staleOpenCount,
    staleOpenPct: record.staleOpenPct,
    lastManualStageChangeAt: record.lastManualStageChangeAt,
  };
}

function displayBusinessName(record: AgencyCampaignRecord | undefined): string {
  if (!record) return "Unknown location";
  if (record.businessName && record.businessName.trim()) return record.businessName;
  if (record.ownerFirstName || record.ownerLastName) {
    return [record.ownerFirstName, record.ownerLastName]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return record.locationId;
}

export async function buildAgencyRollupView(
  snapshotId?: number
): Promise<AgencyRollupView | null> {
  const snapshot = snapshotId
    ? await getSnapshotById(snapshotId)
    : await getLatestCompleteSnapshot();
  if (!snapshot) return null;

  const [campaignRecords, campaignMonths] = await Promise.all([
    listCampaigns(),
    listSnapshotCampaignMonths(snapshot.id),
  ]);

  const recordByKey = new Map(
    campaignRecords.map((c) => [c.campaignKey, c])
  );
  const monthRanges = getMonthsBack(snapshot.monthsCovered);
  const orderedMonthKeys = monthRanges
    .map((m) => ({ monthKey: m.monthKey, startDate: m.startDate, endDate: m.endDate }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  const monthlyAccum = new Map<string, MonthlyAccum>(
    orderedMonthKeys.map((m) => [
      m.monthKey,
      {
        monthKey: m.monthKey,
        startDate: m.startDate,
        endDate: m.endDate,
        leads: 0,
        totalAppts: 0,
        showed: 0,
        noShow: 0,
        closed: 0,
        totalValue: 0,
        successValue: 0,
        adSpend: 0,
        clientCount: 0,
        bookingRates: [],
        showRates: [],
        closeRates: [],
      },
    ])
  );

  const monthsByCampaign = new Map<string, AgencyCampaignMonth[]>();
  for (const row of campaignMonths) {
    const list = monthsByCampaign.get(row.campaignKey) ?? [];
    list.push(row);
    monthsByCampaign.set(row.campaignKey, list);
  }

  const campaignSummaries: CampaignSummary[] = [];

  for (const [campaignKey, rows] of monthsByCampaign.entries()) {
    const byKey = new Map<string, AgencyCampaignMonth>(
      rows.map((r) => [r.monthKey, r])
    );
    const months: CampaignMonthly[] = orderedMonthKeys.map(({ monthKey }) => {
      const row = byKey.get(monthKey);
      return buildCampaignMonth(monthKey, row?.metrics ?? null, row?.adSpend ?? 0);
    });

    const anyError = rows.find((r) => r.status !== "ok");
    const included = !anyError;

    if (included) {
      for (const m of months) {
        const bucket = monthlyAccum.get(m.monthKey);
        if (!bucket) continue;
        bucket.leads += m.leads;
        bucket.totalAppts += m.totalAppts;
        bucket.showed += m.showed;
        bucket.noShow += m.noShow;
        bucket.closed += m.closed;
        bucket.totalValue += m.totalValue;
        bucket.successValue += m.successValue;
        bucket.adSpend += m.adSpend;
        const hasSignal =
          m.leads > 0 ||
          m.totalAppts > 0 ||
          m.showed > 0 ||
          m.noShow > 0 ||
          m.closed > 0 ||
          m.adSpend > 0;
        if (hasSignal) bucket.clientCount += 1;
        if (m.bookingRate != null) bucket.bookingRates.push(m.bookingRate);
        if (m.showRate != null) bucket.showRates.push(m.showRate);
        if (m.closeRate != null) bucket.closeRates.push(m.closeRate);
      }
    }

    const record = recordByKey.get(campaignKey);
    const ownerName = record
      ? [record.ownerFirstName, record.ownerLastName]
          .filter(Boolean)
          .join(" ")
          .trim() || null
      : null;

    campaignSummaries.push({
      campaignKey,
      locationId: record?.locationId ?? rows[0]?.locationId ?? "",
      status: (record?.status ?? "ACTIVE") as CampaignStatus,
      cid: record?.cid ?? null,
      businessName: displayBusinessName(record),
      ownerName,
      pipelineId: record?.pipelineId ?? null,
      pipelineName: record?.pipelineName ?? null,
      pipelineKeyword: record?.pipelineKeyword ?? null,
      campaignKeyword: record?.campaignKeyword ?? null,
      adAccountId: record?.adAccountId ?? null,
      included,
      errorMessage: anyError?.errorMessage ?? null,
      needsSetupReason: record?.needsSetupReason ?? null,
      dataQuality: extractDataQuality(record),
      totals: sumCampaignMonthly(months),
      latestMonth: months[months.length - 1] ?? null,
      months,
    });
  }

  // Include campaigns that have no month rows yet (edge case — sheet row
  // added between rollup runs). These show as "needs setup" in the UI.
  for (const record of campaignRecords) {
    if (monthsByCampaign.has(record.campaignKey)) continue;
    const months: CampaignMonthly[] = orderedMonthKeys.map(({ monthKey }) =>
      buildCampaignMonth(monthKey, null, 0)
    );
    const ownerName =
      [record.ownerFirstName, record.ownerLastName]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
    campaignSummaries.push({
      campaignKey: record.campaignKey,
      locationId: record.locationId,
      status: record.status,
      cid: record.cid,
      businessName: displayBusinessName(record),
      ownerName,
      pipelineId: record.pipelineId,
      pipelineName: record.pipelineName,
      pipelineKeyword: record.pipelineKeyword,
      campaignKeyword: record.campaignKeyword,
      adAccountId: record.adAccountId,
      included: false,
      errorMessage: record.needsSetupReason,
      needsSetupReason: record.needsSetupReason,
      dataQuality: extractDataQuality(record),
      totals: sumCampaignMonthly(months),
      latestMonth: months[months.length - 1] ?? null,
      months,
    });
  }

  campaignSummaries.sort((a, b) => {
    const nameCmp = a.businessName.localeCompare(b.businessName);
    if (nameCmp !== 0) return nameCmp;
    // ACTIVE before 2ND CMPN at the same business.
    if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
    return a.campaignKey.localeCompare(b.campaignKey);
  });

  const monthTotals: MonthTotals[] = orderedMonthKeys.map(({ monthKey }) => {
    const bucket = monthlyAccum.get(monthKey)!;
    const weightedApptsPool =
      bucket.totalAppts + bucket.showed + bucket.noShow + bucket.closed;
    const weightedLeadPool = bucket.leads + weightedApptsPool;
    const weightedShowPool = bucket.showed + bucket.closed;

    return {
      monthKey: bucket.monthKey,
      startDate: bucket.startDate,
      endDate: bucket.endDate,
      leads: bucket.leads,
      totalAppts: bucket.totalAppts,
      showed: bucket.showed,
      noShow: bucket.noShow,
      closed: bucket.closed,
      totalValue: bucket.totalValue,
      successValue: bucket.successValue,
      adSpend: bucket.adSpend,
      clientCount: bucket.clientCount,
      bookingRateSimple: average(bucket.bookingRates),
      bookingRateWeighted:
        weightedLeadPool > 0
          ? rateOrNull(weightedApptsPool, weightedLeadPool)
          : null,
      showRateSimple: average(bucket.showRates),
      showRateWeighted:
        weightedApptsPool > 0
          ? rateOrNull(bucket.showed + bucket.closed, weightedApptsPool)
          : null,
      closeRateSimple: average(bucket.closeRates),
      closeRateWeighted: rateOrNull(bucket.closed, weightedShowPool),
      cpl:
        bucket.adSpend > 0 && bucket.leads > 0
          ? moneyOrNull(bucket.adSpend, bucket.leads)
          : null,
      cps:
        bucket.adSpend > 0 && bucket.showed > 0
          ? moneyOrNull(bucket.adSpend, bucket.showed)
          : null,
      cpClose:
        bucket.adSpend > 0 && bucket.closed > 0
          ? moneyOrNull(bucket.adSpend, bucket.closed)
          : null,
      roas:
        bucket.adSpend > 0
          ? moneyOrNull(bucket.successValue, bucket.adSpend)
          : null,
    };
  });

  return {
    snapshot,
    months: monthTotals,
    campaigns: campaignSummaries,
  };
}

export const METRIC_META: Record<
  MetricKey,
  {
    label: string;
    kind: "count" | "money" | "rate" | "ratio";
    higherIsBetter: boolean;
  }
> = {
  leads: { label: "Leads", kind: "count", higherIsBetter: true },
  totalAppts: { label: "Appointments", kind: "count", higherIsBetter: true },
  showed: { label: "Showed", kind: "count", higherIsBetter: true },
  closed: { label: "Closed", kind: "count", higherIsBetter: true },
  totalValue: { label: "Pipeline value", kind: "money", higherIsBetter: true },
  successValue: { label: "Closed value", kind: "money", higherIsBetter: true },
  adSpend: { label: "Ad spend", kind: "money", higherIsBetter: false },
  bookingRate: { label: "Booking rate", kind: "rate", higherIsBetter: true },
  showRate: { label: "Show rate", kind: "rate", higherIsBetter: true },
  closeRate: { label: "Close rate", kind: "rate", higherIsBetter: true },
  cpl: { label: "Cost / Lead", kind: "money", higherIsBetter: false },
  cps: { label: "Cost / Show", kind: "money", higherIsBetter: false },
  cpClose: { label: "Cost / Close", kind: "money", higherIsBetter: false },
  roas: { label: "ROAS", kind: "ratio", higherIsBetter: true },
};

export function getCampaignMetricValue(
  monthly: CampaignMonthly,
  metric: MetricKey
): number | null {
  switch (metric) {
    case "leads":
      return monthly.leads;
    case "totalAppts":
      return monthly.totalAppts;
    case "showed":
      return monthly.showed;
    case "closed":
      return monthly.closed;
    case "totalValue":
      return monthly.totalValue;
    case "successValue":
      return monthly.successValue;
    case "adSpend":
      return monthly.adSpend;
    case "bookingRate":
      return monthly.bookingRate;
    case "showRate":
      return monthly.showRate;
    case "closeRate":
      return monthly.closeRate;
    case "cpl":
      return monthly.cpl;
    case "cps":
      return monthly.cps;
    case "cpClose":
      return monthly.cpClose;
    case "roas":
      return monthly.roas;
    default:
      return null;
  }
}
