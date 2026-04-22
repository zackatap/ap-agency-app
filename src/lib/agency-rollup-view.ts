/**
 * Builds the payload served to the agency dashboard from a stored snapshot.
 *
 * v3 shape (day-grained storage):
 *   - Days table is the source of truth.
 *   - Caller passes a {@link DateRange} ({@link DateRangePreset} resolved on
 *     the API route); we also compute the immediately-prior period of equal
 *     length for the KPI comparison.
 *   - Per-campaign `totals` / `priorTotals` are pre-aggregated over the
 *     selected range so the UI never has to reason about partial months.
 *   - `months[]` (both agency-level and per-campaign) always spans the
 *     full 13 calendar months covered by the snapshot so the trend charts
 *     keep their long-range context regardless of the selected KPI range.
 *
 * Averages policy (unchanged from v2):
 *   - Sum metrics (leads, appts, showed, closed, spend, value) pool across
 *     every campaign.
 *   - Rate metrics (booking/show/close, cpl/cps/cpclose/roas) are computed
 *     per campaign over its totals and then simple-averaged across
 *     contributing campaigns. A campaign with zero denominator doesn't
 *     "vote" with 0%.
 */

import { getMonthsBack, getPreviousPeriod } from "@/lib/date-ranges";
import {
  getLatestCompleteSnapshot,
  getSnapshotById,
  listCampaigns,
  listSnapshotCampaignDays,
  listSnapshotCampaignRuns,
  type AgencyCampaignDay,
  type AgencyCampaignRecord,
  type AgencyCampaignRun,
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

export interface DateRangeDescriptor {
  preset: string;
  startDate: string;
  endDate: string;
  label?: string;
}

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

export interface CampaignWindowTotals {
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

export interface CampaignDataQuality {
  movementRatio: number | null;
  openCount: number | null;
  staleOpenCount: number | null;
  staleOpenPct: number | null;
  lastManualStageChangeAt: string | null;
}

export interface CampaignSummary {
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
  errorMessage: string | null;
  needsSetupReason: string | null;
  dataQuality: CampaignDataQuality;
  totals: CampaignWindowTotals;
  priorTotals: CampaignWindowTotals;
  latestMonth: CampaignMonthly | null;
  months: CampaignMonthly[];
}

export interface AgencyRollupView {
  snapshot: AgencySnapshot;
  range: DateRangeDescriptor;
  priorRange: DateRangeDescriptor;
  months: MonthTotals[];
  campaigns: CampaignSummary[];
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

/**
 * Compute funnel rates + cost ratios from a raw sum-of-counts/values bucket.
 * Used for both per-campaign window totals and per-campaign-per-month rows.
 * No-shows count as booked (matches applyRollup in funnel-metrics.ts).
 */
function deriveRates(base: {
  leads: number;
  totalAppts: number;
  showed: number;
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
}): CampaignWindowTotals {
  const apptPool = base.totalAppts + base.showed + base.noShow + base.closed;
  const leadPool = base.leads + apptPool;
  const showPool = base.showed + base.closed;
  return {
    ...base,
    bookingRate: leadPool > 0 ? rateOrNull(apptPool, leadPool) : null,
    showRate: apptPool > 0 ? rateOrNull(base.showed + base.closed, apptPool) : null,
    closeRate: rateOrNull(base.closed, showPool),
    cpl: base.adSpend > 0 && base.leads > 0 ? moneyOrNull(base.adSpend, base.leads) : null,
    cps: base.adSpend > 0 && base.showed > 0 ? moneyOrNull(base.adSpend, base.showed) : null,
    cpClose:
      base.adSpend > 0 && base.closed > 0
        ? moneyOrNull(base.adSpend, base.closed)
        : null,
    roas: base.adSpend > 0 ? moneyOrNull(base.successValue, base.adSpend) : null,
  };
}

function emptyAccumulator(): {
  leads: number;
  totalAppts: number;
  showed: number;
  noShow: number;
  closed: number;
  totalValue: number;
  successValue: number;
  adSpend: number;
} {
  return {
    leads: 0,
    totalAppts: 0,
    showed: 0,
    noShow: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
  };
}

function accumulateDay(
  acc: ReturnType<typeof emptyAccumulator>,
  row: AgencyCampaignDay
): void {
  acc.leads += row.leads;
  acc.totalAppts += row.totalAppts;
  acc.showed += row.showed;
  acc.noShow += row.noShow;
  acc.closed += row.closed;
  acc.totalValue += row.totalValue;
  acc.successValue += row.successValue;
  acc.adSpend += row.adSpend;
}

function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
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

function emptyWindowTotals(): CampaignWindowTotals {
  return deriveRates(emptyAccumulator());
}

function emptyMonth(monthKey: string): CampaignMonthly {
  return {
    monthKey,
    ...deriveRates(emptyAccumulator()),
  };
}

export async function buildAgencyRollupView(params?: {
  snapshotId?: number;
  range?: DateRangeDescriptor;
}): Promise<AgencyRollupView | null> {
  const snapshot = params?.snapshotId
    ? await getSnapshotById(params.snapshotId)
    : await getLatestCompleteSnapshot();
  if (!snapshot) return null;

  // Default range = most recent calendar month (matches old "Latest month"
  // default). The API route resolves real presets; this fallback only kicks
  // in if the caller doesn't specify one.
  const monthRanges = getMonthsBack(snapshot.monthsCovered);
  const orderedMonthKeys = monthRanges
    .map((m) => ({ monthKey: m.monthKey, startDate: m.startDate, endDate: m.endDate }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  const defaultRange: DateRangeDescriptor = params?.range ?? {
    preset: "last_month",
    startDate: orderedMonthKeys[orderedMonthKeys.length - 1]?.startDate ?? "",
    endDate: orderedMonthKeys[orderedMonthKeys.length - 1]?.endDate ?? "",
  };
  const priorRaw = getPreviousPeriod({
    startDate: defaultRange.startDate,
    endDate: defaultRange.endDate,
  });
  const priorRange: DateRangeDescriptor = {
    preset: "prior",
    startDate: priorRaw.startDate,
    endDate: priorRaw.endDate,
  };

  const [campaignRecords, days, runs] = await Promise.all([
    listCampaigns(),
    listSnapshotCampaignDays(snapshot.id),
    listSnapshotCampaignRuns(snapshot.id),
  ]);

  const recordByKey = new Map(campaignRecords.map((c) => [c.campaignKey, c]));
  const runByKey = new Map<string, AgencyCampaignRun>(
    runs.map((r) => [r.campaignKey, r])
  );

  const daysByCampaign = new Map<string, AgencyCampaignDay[]>();
  for (const row of days) {
    const list = daysByCampaign.get(row.campaignKey) ?? [];
    list.push(row);
    daysByCampaign.set(row.campaignKey, list);
  }

  interface AgencyMonthAccum {
    monthKey: string;
    startDate: string;
    endDate: string;
    sums: ReturnType<typeof emptyAccumulator>;
    clientCount: number;
    bookingRates: number[];
    showRates: number[];
    closeRates: number[];
  }

  const monthlyAccum = new Map<string, AgencyMonthAccum>(
    orderedMonthKeys.map((m) => [
      m.monthKey,
      {
        monthKey: m.monthKey,
        startDate: m.startDate,
        endDate: m.endDate,
        sums: emptyAccumulator(),
        clientCount: 0,
        bookingRates: [],
        showRates: [],
        closeRates: [],
      },
    ])
  );

  const seenCampaignKeys = new Set<string>();
  const campaignSummaries: CampaignSummary[] = [];

  // Iterate per-campaign. Each campaign's days array is already filtered
  // to that campaign; we bucket by (monthKey, current, prior) in one pass.
  for (const [campaignKey, rows] of daysByCampaign.entries()) {
    seenCampaignKeys.add(campaignKey);

    const monthSums = new Map<string, ReturnType<typeof emptyAccumulator>>();
    for (const m of orderedMonthKeys) monthSums.set(m.monthKey, emptyAccumulator());

    const currentSums = emptyAccumulator();
    const priorSums = emptyAccumulator();

    for (const row of rows) {
      const monthKey = row.date.slice(0, 7);
      const monthBucket = monthSums.get(monthKey);
      if (monthBucket) accumulateDay(monthBucket, row);

      if (inRange(row.date, defaultRange.startDate, defaultRange.endDate)) {
        accumulateDay(currentSums, row);
      }
      if (inRange(row.date, priorRange.startDate, priorRange.endDate)) {
        accumulateDay(priorSums, row);
      }
    }

    const months: CampaignMonthly[] = orderedMonthKeys.map(({ monthKey }) => {
      const sum = monthSums.get(monthKey)!;
      return { monthKey, ...deriveRates(sum) };
    });

    const totals = deriveRates(currentSums);
    const priorTotals = deriveRates(priorSums);

    const run = runByKey.get(campaignKey);
    const record = recordByKey.get(campaignKey);
    const included = !run || run.status === "ok";
    // Most snapshots will have a run row; legacy rows without a run row
    // but with day data are treated as ok.
    const errorMessage = run && run.status !== "ok" ? run.errorMessage : null;

    // Roll the campaign's monthly sums into the agency monthly accumulator.
    if (included) {
      for (const month of months) {
        const bucket = monthlyAccum.get(month.monthKey);
        if (!bucket) continue;
        bucket.sums.leads += month.leads;
        bucket.sums.totalAppts += month.totalAppts;
        bucket.sums.showed += month.showed;
        bucket.sums.noShow += month.noShow;
        bucket.sums.closed += month.closed;
        bucket.sums.totalValue += month.totalValue;
        bucket.sums.successValue += month.successValue;
        bucket.sums.adSpend += month.adSpend;
        const hasSignal =
          month.leads > 0 ||
          month.totalAppts > 0 ||
          month.showed > 0 ||
          month.noShow > 0 ||
          month.closed > 0 ||
          month.adSpend > 0;
        if (hasSignal) bucket.clientCount += 1;
        if (month.bookingRate != null) bucket.bookingRates.push(month.bookingRate);
        if (month.showRate != null) bucket.showRates.push(month.showRate);
        if (month.closeRate != null) bucket.closeRates.push(month.closeRate);
      }
    }

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
      errorMessage,
      needsSetupReason: record?.needsSetupReason ?? null,
      dataQuality: extractDataQuality(record),
      totals,
      priorTotals,
      latestMonth: months[months.length - 1] ?? null,
      months,
    });
  }

  // Campaigns that exist in the roster but produced no day rows (new sheet
  // row, needs-setup, or fully failed). Surface them with empty data so the
  // UI can show a "needs setup" row.
  for (const record of campaignRecords) {
    if (seenCampaignKeys.has(record.campaignKey)) continue;
    const run = runByKey.get(record.campaignKey);
    const months: CampaignMonthly[] = orderedMonthKeys.map(({ monthKey }) =>
      emptyMonth(monthKey)
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
      errorMessage:
        run?.status !== "ok" ? run?.errorMessage ?? record.needsSetupReason : null,
      needsSetupReason: record.needsSetupReason,
      dataQuality: extractDataQuality(record),
      totals: emptyWindowTotals(),
      priorTotals: emptyWindowTotals(),
      latestMonth: months[months.length - 1] ?? null,
      months,
    });
  }

  campaignSummaries.sort((a, b) => {
    const nameCmp = a.businessName.localeCompare(b.businessName);
    if (nameCmp !== 0) return nameCmp;
    if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
    return a.campaignKey.localeCompare(b.campaignKey);
  });

  const monthTotals: MonthTotals[] = orderedMonthKeys.map(({ monthKey }) => {
    const bucket = monthlyAccum.get(monthKey)!;
    const s = bucket.sums;
    const weightedApptsPool = s.totalAppts + s.showed + s.noShow + s.closed;
    const weightedLeadPool = s.leads + weightedApptsPool;
    const weightedShowPool = s.showed + s.closed;
    return {
      monthKey: bucket.monthKey,
      startDate: bucket.startDate,
      endDate: bucket.endDate,
      leads: s.leads,
      totalAppts: s.totalAppts,
      showed: s.showed,
      noShow: s.noShow,
      closed: s.closed,
      totalValue: s.totalValue,
      successValue: s.successValue,
      adSpend: s.adSpend,
      clientCount: bucket.clientCount,
      bookingRateSimple: average(bucket.bookingRates),
      bookingRateWeighted:
        weightedLeadPool > 0
          ? rateOrNull(weightedApptsPool, weightedLeadPool)
          : null,
      showRateSimple: average(bucket.showRates),
      showRateWeighted:
        weightedApptsPool > 0
          ? rateOrNull(s.showed + s.closed, weightedApptsPool)
          : null,
      closeRateSimple: average(bucket.closeRates),
      closeRateWeighted: rateOrNull(s.closed, weightedShowPool),
      cpl: s.adSpend > 0 && s.leads > 0 ? moneyOrNull(s.adSpend, s.leads) : null,
      cps:
        s.adSpend > 0 && s.showed > 0 ? moneyOrNull(s.adSpend, s.showed) : null,
      cpClose:
        s.adSpend > 0 && s.closed > 0 ? moneyOrNull(s.adSpend, s.closed) : null,
      roas: s.adSpend > 0 ? moneyOrNull(s.successValue, s.adSpend) : null,
    };
  });

  return {
    snapshot,
    range: defaultRange,
    priorRange,
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

export function getCampaignTotalsMetricValue(
  totals: CampaignWindowTotals,
  metric: MetricKey
): number | null {
  switch (metric) {
    case "leads":
      return totals.leads;
    case "totalAppts":
      return totals.totalAppts;
    case "showed":
      return totals.showed;
    case "closed":
      return totals.closed;
    case "totalValue":
      return totals.totalValue;
    case "successValue":
      return totals.successValue;
    case "adSpend":
      return totals.adSpend;
    case "bookingRate":
      return totals.bookingRate;
    case "showRate":
      return totals.showRate;
    case "closeRate":
      return totals.closeRate;
    case "cpl":
      return totals.cpl;
    case "cps":
      return totals.cps;
    case "cpClose":
      return totals.cpClose;
    case "roas":
      return totals.roas;
    default:
      return null;
  }
}
