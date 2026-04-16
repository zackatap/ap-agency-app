/**
 * Builds the payload served to the agency dashboard from a stored snapshot.
 *
 * Responsibilities:
 *   - Pull the snapshot row, its per-location-per-month rows, and the client roster.
 *   - Compute agency-level aggregates (totals + simple-average rates + weighted rates).
 *   - Compute per-location 13-month series and latest-month benchmark stats.
 *   - Return a JSON-friendly shape the React UI can render without further math.
 *
 * Averages policy:
 *   - "Simple average" = mean of each client's per-client rate. This is the
 *     headline number for cross-client comparisons (each client counted once).
 *   - "Weighted average" = sum(numerator) / sum(denominator) across clients.
 *     Shown alongside as the agency-wide "true" rate for totals context.
 */

import { getMonthsBack } from "@/lib/date-ranges";
import type { FunnelMetrics } from "@/lib/funnel-metrics";
import {
  getLatestCompleteSnapshot,
  getSnapshotById,
  listClients,
  listSnapshotLocationMonths,
  type AgencyClientRecord,
  type AgencyLocationMonth,
  type AgencySnapshot,
} from "@/lib/agency-rollup-store";

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

export interface LocationMonthly {
  monthKey: string;
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

export interface LocationSummary {
  locationId: string;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  statuses: string[];
  pipelineName: string | null;
  included: boolean;
  errorMessage: string | null;
  totals: Omit<LocationMonthly, "monthKey">;
  latestMonth: LocationMonthly | null;
  months: LocationMonthly[];
}

export interface AgencyRollupView {
  snapshot: AgencySnapshot;
  months: MonthTotals[];
  locations: LocationSummary[];
}

interface MonthlyAccum {
  monthKey: string;
  startDate: string;
  endDate: string;
  leads: number;
  totalAppts: number;
  showed: number;
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

function buildLocationMonth(
  monthKey: string,
  metrics: FunnelMetrics | null,
  adSpend: number
): LocationMonthly {
  const leads = metrics?.leads ?? 0;
  const totalAppts = metrics?.totalAppts ?? 0;
  const showed = metrics?.showed ?? 0;
  const closed = metrics?.closed ?? 0;
  const totalValue = metrics?.totalValue ?? 0;
  const successValue = metrics?.successValue ?? 0;

  const leadPool = leads + totalAppts + showed + closed;
  const bookingRate =
    leadPool > 0 ? rateOrNull(totalAppts + showed + closed, leadPool) : null;
  const showRate =
    totalAppts + showed + closed > 0
      ? rateOrNull(showed + closed, totalAppts + showed + closed)
      : null;
  const closeRate = rateOrNull(closed, showed + closed);

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
    cpl: adSpend > 0 ? moneyOrNull(adSpend, leads) : null,
    cps: adSpend > 0 ? moneyOrNull(adSpend, showed) : null,
    cpClose: adSpend > 0 ? moneyOrNull(adSpend, closed) : null,
    roas: adSpend > 0 ? moneyOrNull(successValue, adSpend) : null,
  };
}

function sumLocationMonthly(
  months: LocationMonthly[]
): Omit<LocationMonthly, "monthKey"> {
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
  const leadPool =
    totals.leads + totals.totalAppts + totals.showed + totals.closed;
  return {
    ...totals,
    bookingRate:
      leadPool > 0
        ? rateOrNull(totals.totalAppts + totals.showed + totals.closed, leadPool)
        : null,
    showRate:
      totals.totalAppts + totals.showed + totals.closed > 0
        ? rateOrNull(
            totals.showed + totals.closed,
            totals.totalAppts + totals.showed + totals.closed
          )
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

function displayBusinessName(client: AgencyClientRecord | undefined): string {
  if (!client) return "Unknown location";
  if (client.businessName && client.businessName.trim()) return client.businessName;
  if (client.ownerFirstName || client.ownerLastName) {
    return [client.ownerFirstName, client.ownerLastName]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return client.locationId;
}

export async function buildAgencyRollupView(
  snapshotId?: number
): Promise<AgencyRollupView | null> {
  const snapshot = snapshotId
    ? await getSnapshotById(snapshotId)
    : await getLatestCompleteSnapshot();
  if (!snapshot) return null;

  const [clients, locationMonths] = await Promise.all([
    listClients(),
    listSnapshotLocationMonths(snapshot.id),
  ]);

  const clientById = new Map(clients.map((c) => [c.locationId, c]));
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

  const locationMonthsByLocation = new Map<string, AgencyLocationMonth[]>();
  for (const row of locationMonths) {
    const list = locationMonthsByLocation.get(row.locationId) ?? [];
    list.push(row);
    locationMonthsByLocation.set(row.locationId, list);
  }

  const locationSummaries: LocationSummary[] = [];

  for (const [locationId, rows] of locationMonthsByLocation.entries()) {
    const byKey = new Map<string, AgencyLocationMonth>(
      rows.map((r) => [r.monthKey, r])
    );
    const months: LocationMonthly[] = orderedMonthKeys.map(({ monthKey }) => {
      const row = byKey.get(monthKey);
      return buildLocationMonth(monthKey, row?.metrics ?? null, row?.adSpend ?? 0);
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
        bucket.closed += m.closed;
        bucket.totalValue += m.totalValue;
        bucket.successValue += m.successValue;
        bucket.adSpend += m.adSpend;
        const hasSignal =
          m.leads > 0 ||
          m.totalAppts > 0 ||
          m.showed > 0 ||
          m.closed > 0 ||
          m.adSpend > 0;
        if (hasSignal) bucket.clientCount += 1;
        if (m.bookingRate != null) bucket.bookingRates.push(m.bookingRate);
        if (m.showRate != null) bucket.showRates.push(m.showRate);
        if (m.closeRate != null) bucket.closeRates.push(m.closeRate);
      }
    }

    const client = clientById.get(locationId);
    const ownerName = client
      ? [client.ownerFirstName, client.ownerLastName]
          .filter(Boolean)
          .join(" ")
          .trim() || null
      : null;

    locationSummaries.push({
      locationId,
      cid: client?.cid ?? null,
      businessName: displayBusinessName(client),
      ownerName,
      statuses: client?.statuses ?? [],
      pipelineName: client?.pipelineName ?? null,
      included,
      errorMessage: anyError?.errorMessage ?? null,
      totals: sumLocationMonthly(months),
      latestMonth: months[months.length - 1] ?? null,
      months,
    });
  }

  locationSummaries.sort((a, b) => a.businessName.localeCompare(b.businessName));

  const monthTotals: MonthTotals[] = orderedMonthKeys.map(({ monthKey }) => {
    const bucket = monthlyAccum.get(monthKey)!;
    const weightedLeadPool =
      bucket.leads + bucket.totalAppts + bucket.showed + bucket.closed;
    const weightedApptsPool =
      bucket.totalAppts + bucket.showed + bucket.closed;
    const weightedShowPool = bucket.showed + bucket.closed;

    return {
      monthKey: bucket.monthKey,
      startDate: bucket.startDate,
      endDate: bucket.endDate,
      leads: bucket.leads,
      totalAppts: bucket.totalAppts,
      showed: bucket.showed,
      closed: bucket.closed,
      totalValue: bucket.totalValue,
      successValue: bucket.successValue,
      adSpend: bucket.adSpend,
      clientCount: bucket.clientCount,
      bookingRateSimple: average(bucket.bookingRates),
      bookingRateWeighted:
        weightedLeadPool > 0
          ? rateOrNull(
              bucket.totalAppts + bucket.showed + bucket.closed,
              weightedLeadPool
            )
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
    locations: locationSummaries,
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

export function getLocationMetricValue(
  monthly: LocationMonthly,
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
