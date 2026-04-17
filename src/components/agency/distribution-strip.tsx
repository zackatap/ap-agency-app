"use client";

import { useMemo } from "react";
import type { ClientCampaignSummary, MetricKey } from "./types";
import { METRIC_META } from "./metric-meta";
import { buildDistribution, getCampaignMetric } from "./benchmarks";
import { formatMetricValue } from "./format";

interface Props {
  campaigns: ClientCampaignSummary[];
  metric: MetricKey;
  monthKey: string | "total";
  highlightedCampaignKey?: string;
  onSelect?: (campaign: ClientCampaignSummary) => void;
}

/**
 * A horizontal distribution strip ("dot plot"): each campaign is a dot on the
 * metric axis. The highlighted campaign is shown bigger and labeled. Great
 * for showing where a single campaign sits relative to the rest of the agency.
 */
export function DistributionStrip({
  campaigns,
  metric,
  monthKey,
  highlightedCampaignKey,
  onSelect,
}: Props) {
  const meta = METRIC_META[metric];
  const dist = useMemo(
    () => buildDistribution(campaigns, metric, monthKey),
    [campaigns, metric, monthKey]
  );
  const byKey = useMemo(() => {
    const map = new Map<string, ClientCampaignSummary>();
    for (const c of campaigns) map.set(c.campaignKey, c);
    return map;
  }, [campaigns]);

  if (dist.values.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/30 p-6 text-sm text-slate-400">
        No data available for this metric in the selected period.
      </div>
    );
  }

  const minV = dist.min ?? 0;
  const maxV = dist.max ?? 0;
  const range = maxV - minV || 1;

  const pct = (value: number) => ((value - minV) / range) * 100;

  const highlighted = highlightedCampaignKey
    ? byKey.get(highlightedCampaignKey) ?? null
    : null;
  const highlightedValue = highlighted
    ? getCampaignMetric(highlighted, metric, monthKey)
    : null;

  const avg = dist.simpleAverage;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/30 p-4">
      <div className="mb-4 flex items-center justify-between text-xs text-slate-400">
        <span>
          {dist.values.length} campaigns · min {formatMetricValue(minV, meta.kind)}{" "}
          · avg {formatMetricValue(avg, meta.kind)} · max{" "}
          {formatMetricValue(maxV, meta.kind)}
        </span>
        {highlightedValue != null && (
          <span className="text-slate-300">
            This campaign: {formatMetricValue(highlightedValue, meta.kind)}
          </span>
        )}
      </div>
      <div className="relative h-20">
        <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-white/10" />
        {dist.p25 != null && dist.p75 != null && (
          <div
            className="absolute top-1/2 h-6 -translate-y-1/2 rounded bg-indigo-500/20"
            style={{
              left: `${pct(dist.p25)}%`,
              width: `${Math.max(1, pct(dist.p75) - pct(dist.p25))}%`,
            }}
            title="Inter-quartile range (25th–75th percentile)"
          />
        )}
        {avg != null && (
          <div
            className="absolute top-1/2 h-10 w-px -translate-y-1/2 bg-indigo-300"
            style={{ left: `${pct(avg)}%` }}
            title={`Agency average: ${formatMetricValue(avg, meta.kind)}`}
          />
        )}
        {dist.values.map(({ key, value }) => {
          const isHighlight = key === highlightedCampaignKey;
          const campaign = byKey.get(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => campaign && onSelect?.(campaign)}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform ${
                isHighlight
                  ? "z-10 h-4 w-4 bg-amber-400 ring-2 ring-amber-200/50 hover:scale-125"
                  : "h-2 w-2 bg-slate-300/70 hover:scale-150 hover:bg-white"
              }`}
              style={{ left: `${pct(value)}%` }}
              title={`${campaign?.businessName ?? key}${
                campaign && campaign.status !== "ACTIVE" ? ` (${campaign.status})` : ""
              } — ${formatMetricValue(value, meta.kind)}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-500">
        <span>{formatMetricValue(minV, meta.kind)}</span>
        <span>{formatMetricValue(maxV, meta.kind)}</span>
      </div>
    </div>
  );
}
