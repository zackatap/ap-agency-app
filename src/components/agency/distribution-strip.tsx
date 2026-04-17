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
  /**
   * Campaigns flagged by the data-hygiene filter. They're still plotted on
   * the strip (so the user can see where lazy-updater clients land), but
   * drawn dimmed and excluded from the peer-set avg/IQR.
   */
  excludedKeys?: ReadonlySet<string>;
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
  excludedKeys,
  onSelect,
}: Props) {
  const meta = METRIC_META[metric];
  const dist = useMemo(
    () => buildDistribution(campaigns, metric, monthKey, excludedKeys),
    [campaigns, metric, monthKey, excludedKeys]
  );
  const byKey = useMemo(() => {
    const map = new Map<string, ClientCampaignSummary>();
    for (const c of campaigns) map.set(c.campaignKey, c);
    return map;
  }, [campaigns]);

  if (dist.allValues.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/30 p-6 text-sm text-slate-400">
        No data available for this metric in the selected period.
      </div>
    );
  }

  // Axis scale uses ALL dots (including excluded) so the layout doesn't
  // shift when the filter toggle changes.
  const allVals = dist.allValues.map((v) => v.value);
  const minV = allVals.length ? Math.min(...allVals) : 0;
  const maxV = allVals.length ? Math.max(...allVals) : 0;
  const range = maxV - minV || 1;

  const pct = (value: number) => ((value - minV) / range) * 100;

  const highlighted = highlightedCampaignKey
    ? byKey.get(highlightedCampaignKey) ?? null
    : null;
  const highlightedValue = highlighted
    ? getCampaignMetric(highlighted, metric, monthKey)
    : null;

  const avg = dist.simpleAverage;
  const excludedCount = dist.allValues.length - dist.values.length;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/30 p-4">
      <div className="mb-4 flex items-center justify-between text-xs text-slate-400">
        <span>
          {dist.values.length} campaigns
          {excludedCount > 0 && (
            <span className="text-amber-300">
              {" · "}
              {excludedCount} excluded
            </span>
          )}{" "}
          · min {formatMetricValue(minV, meta.kind)} · avg{" "}
          {formatMetricValue(avg, meta.kind)} · max{" "}
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
            title="Inter-quartile range (25th–75th percentile, trusted campaigns only)"
          />
        )}
        {avg != null && (
          <div
            className="absolute top-1/2 h-10 w-px -translate-y-1/2 bg-indigo-300"
            style={{ left: `${pct(avg)}%` }}
            title={`Agency average: ${formatMetricValue(avg, meta.kind)}`}
          />
        )}
        {dist.allValues.map(({ key, value, excluded }) => {
          const isHighlight = key === highlightedCampaignKey;
          const campaign = byKey.get(key);
          const base = isHighlight
            ? "z-10 h-4 w-4 bg-amber-400 ring-2 ring-amber-200/50 hover:scale-125"
            : excluded
              ? "h-2 w-2 bg-slate-600/60 ring-1 ring-slate-500/40 hover:scale-150 hover:bg-slate-400"
              : "h-2 w-2 bg-slate-300/70 hover:scale-150 hover:bg-white";
          return (
            <button
              key={key}
              type="button"
              onClick={() => campaign && onSelect?.(campaign)}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform ${base}`}
              style={{ left: `${pct(value)}%` }}
              title={`${campaign?.businessName ?? key}${
                campaign && campaign.status !== "ACTIVE"
                  ? ` (${campaign.status})`
                  : ""
              }${excluded ? " — data excluded from average" : ""} — ${formatMetricValue(
                value,
                meta.kind
              )}`}
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
