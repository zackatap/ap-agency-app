import type {
  ClientLocationMonth,
  ClientLocationSummary,
  MetricKey,
} from "./types";
import { METRIC_META } from "./metric-meta";

function getValue(
  month: ClientLocationMonth | null | undefined,
  metric: MetricKey
): number | null {
  if (!month) return null;
  const v = (month as unknown as Record<string, number | null>)[metric];
  return v == null ? null : Number(v);
}

export function getLocationMetric(
  loc: ClientLocationSummary,
  metric: MetricKey,
  monthKey: string | "total"
): number | null {
  if (monthKey === "total") {
    const source = {
      monthKey: "",
      ...loc.totals,
    } as unknown as ClientLocationMonth;
    return getValue(source, metric);
  }
  const monthly = loc.months.find((m) => m.monthKey === monthKey);
  return getValue(monthly, metric);
}

export interface Distribution {
  values: Array<{ locationId: string; value: number }>;
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
  locations: ClientLocationSummary[],
  metric: MetricKey,
  monthKey: string | "total"
): Distribution {
  const values = locations
    .filter((l) => l.included)
    .map((l) => ({
      locationId: l.locationId,
      value: getLocationMetric(l, metric, monthKey),
    }))
    .filter((v): v is { locationId: string; value: number } => v.value != null)
    .map((v) => ({ locationId: v.locationId, value: v.value }));

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
 * Percentile = % of other clients that a lower metric beats (or ties) us on,
 * inverted when `higherIsBetter=false` so "95th percentile" always means "best".
 */
export function computeRank(
  dist: Distribution,
  locationId: string,
  metric: MetricKey
): Rank | null {
  const meta = METRIC_META[metric];
  const entries = dist.values.slice();
  entries.sort((a, b) =>
    meta.higherIsBetter ? b.value - a.value : a.value - b.value
  );
  const idx = entries.findIndex((e) => e.locationId === locationId);
  if (idx < 0) return null;
  const rank = idx + 1;
  const of = entries.length;
  const percentile =
    of <= 1 ? 100 : Math.round(((of - rank) / (of - 1)) * 100);
  return { rank, of, percentile };
}
