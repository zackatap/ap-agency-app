"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ClientCampaignSummary,
  ClientMonthTotals,
  ClientRollupView,
  MetricKey,
} from "./types";
import { METRIC_META, METRIC_ORDER } from "./metric-meta";
import { buildDistribution, computeRank } from "./benchmarks";
import { DistributionStrip } from "./distribution-strip";
import {
  formatDateTime,
  formatMetricValue,
  formatMonthLabel,
  ordinalSuffix,
} from "./format";

interface Props {
  view: ClientRollupView;
  locationId: string;
  /** Pick a specific campaign at this location. Falls back to first included. */
  campaignKey?: string | null;
  /** Hide the header block (used when embedding inside the location dashboard) */
  compact?: boolean;
}

function getMonthValue(
  months: ClientCampaignSummary["months"],
  monthKey: string,
  metric: MetricKey
): number | null {
  const m = months.find((mm) => mm.monthKey === monthKey);
  if (!m) return null;
  const v = (m as unknown as Record<string, number | null>)[metric];
  return v == null ? null : Number(v);
}

function getAgencyAvgForMonth(
  months: ClientMonthTotals[],
  monthKey: string,
  metric: MetricKey
): number | null {
  const m = months.find((mm) => mm.monthKey === monthKey);
  if (!m) return null;
  switch (metric) {
    case "leads":
    case "totalAppts":
    case "showed":
    case "closed":
    case "totalValue":
    case "successValue":
    case "adSpend":
      if (!m.clientCount) return null;
      return (
        Math.round(
          ((m as unknown as Record<string, number>)[metric] / m.clientCount) *
            10
        ) / 10
      );
    case "bookingRate":
      return m.bookingRateSimple;
    case "showRate":
      return m.showRateSimple;
    case "closeRate":
      return m.closeRateSimple;
    case "cpl":
      return m.cpl;
    case "cps":
      return m.cps;
    case "cpClose":
      return m.cpClose;
    case "roas":
      return m.roas;
    default:
      return null;
  }
}

export function ClientBenchmark({ view, locationId, campaignKey, compact }: Props) {
  const campaignsAtLocation = useMemo(
    () => view.campaigns.filter((c) => c.locationId === locationId),
    [view.campaigns, locationId]
  );

  function pickDefaultCampaignKey(
    list: typeof campaignsAtLocation,
    explicit: string | null | undefined
  ): string | null {
    if (explicit && list.some((c) => c.campaignKey === explicit)) {
      return explicit;
    }
    const preferred =
      list.find((c) => c.status === "ACTIVE" && c.included) ??
      list.find((c) => c.included) ??
      list[0];
    return preferred?.campaignKey ?? null;
  }

  const [selectedCampaignKey, setSelectedCampaignKey] = useState<string | null>(
    () => pickDefaultCampaignKey(campaignsAtLocation, campaignKey)
  );

  // Keep local selection in sync when the parent swaps us onto a new
  // location/campaign. Without this the component holds onto a stale key that
  // no longer exists in the new location's campaign list, and we'd render
  // "Could not resolve a campaign for this location" until the user clears
  // the selection by hand.
  useEffect(() => {
    setSelectedCampaignKey((prev) => {
      if (campaignKey && campaignsAtLocation.some((c) => c.campaignKey === campaignKey)) {
        return campaignKey;
      }
      if (prev && campaignsAtLocation.some((c) => c.campaignKey === prev)) {
        return prev;
      }
      return pickDefaultCampaignKey(campaignsAtLocation, campaignKey);
    });
  }, [campaignKey, campaignsAtLocation]);

  const campaign = useMemo(
    () =>
      campaignsAtLocation.find((c) => c.campaignKey === selectedCampaignKey) ??
      null,
    [campaignsAtLocation, selectedCampaignKey]
  );

  const [focusMetric, setFocusMetric] = useState<MetricKey>("closed");
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | "total">(
    () => view.months[view.months.length - 1]?.monthKey ?? "total"
  );

  const includedCampaigns = useMemo(
    () => view.campaigns.filter((c) => c.included),
    [view.campaigns]
  );

  const rankSummary = useMemo(() => {
    if (!campaign) return [];
    return METRIC_ORDER.map((key) => {
      const dist = buildDistribution(includedCampaigns, key, selectedMonthKey);
      const rank = computeRank(dist, campaign.campaignKey, key);
      const meta = METRIC_META[key];
      const value =
        selectedMonthKey === "total"
          ? (campaign.totals as unknown as Record<string, number | null>)[key] ??
            null
          : getMonthValue(campaign.months, selectedMonthKey, key);
      return {
        key,
        meta,
        rank,
        value,
        average: dist.simpleAverage,
      };
    });
  }, [campaign, includedCampaigns, selectedMonthKey]);

  const trendData = useMemo(() => {
    if (!campaign) return [];
    return view.months.map((m) => ({
      monthKey: m.monthKey,
      month: formatMonthLabel(m.monthKey),
      You: getMonthValue(campaign.months, m.monthKey, focusMetric),
      "Agency avg": getAgencyAvgForMonth(view.months, m.monthKey, focusMetric),
    }));
  }, [campaign, view.months, focusMetric]);

  if (campaignsAtLocation.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-200">
        This location is not part of the latest snapshot. Run a refresh from the
        agency dashboard to include it.
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-200">
        Could not resolve a campaign for this location.
      </div>
    );
  }

  const focusMeta = METRIC_META[focusMetric];
  const showCampaignPicker = campaignsAtLocation.length > 1;

  return (
    <div className="space-y-6">
      {!compact && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Benchmark
            </div>
            <h1 className="mt-1 text-2xl font-semibold text-white">
              {campaign.businessName}
            </h1>
            {campaign.ownerName && (
              <div className="text-sm text-slate-400">{campaign.ownerName}</div>
            )}
            <div className="mt-1 text-xs text-slate-500">
              CID {campaign.cid ?? "—"} ·{" "}
              {campaign.pipelineName ?? campaign.pipelineKeyword ?? "No pipeline"} ·{" "}
              {campaign.status} · Based on snapshot from{" "}
              {formatDateTime(view.snapshot.finishedAt)}
            </div>
          </div>
          <select
            value={selectedMonthKey}
            onChange={(e) =>
              setSelectedMonthKey(e.target.value as string | "total")
            }
            className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
          >
            <option value="total">13-month total</option>
            {view.months.map((m) => (
              <option key={m.monthKey} value={m.monthKey}>
                {formatMonthLabel(m.monthKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      {showCampaignPicker && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-slate-900/30 p-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-400">
            Campaign
          </span>
          {campaignsAtLocation.map((c) => {
            const isActive = c.campaignKey === selectedCampaignKey;
            return (
              <button
                key={c.campaignKey}
                type="button"
                onClick={() => setSelectedCampaignKey(c.campaignKey)}
                className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                  isActive
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-800/50 text-slate-300 hover:bg-slate-800"
                }`}
                title={c.pipelineName ?? c.pipelineKeyword ?? undefined}
              >
                <span className="mr-1.5 text-[10px] opacity-80">
                  {c.status}
                </span>
                {c.pipelineName ?? c.pipelineKeyword ?? "Pipeline"}
              </button>
            );
          })}
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {rankSummary.slice(0, 8).map(({ key, meta, rank, value, average }) => {
          const aboveAverage =
            value != null &&
            average != null &&
            ((meta.higherIsBetter && value >= average) ||
              (!meta.higherIsBetter && value <= average));
          return (
            <button
              key={key}
              onClick={() => setFocusMetric(key)}
              className={`rounded-xl border bg-slate-900/40 p-4 text-left transition-colors ${
                focusMetric === key
                  ? "border-indigo-400/60"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              <div className="text-xs uppercase tracking-wide text-slate-400">
                {meta.label}
              </div>
              <div className="mt-1 text-xl font-semibold text-white">
                {formatMetricValue(value, meta.kind)}
              </div>
              <div
                className={`mt-1 text-xs ${aboveAverage ? "text-emerald-400" : "text-rose-400"}`}
              >
                Avg {formatMetricValue(average, meta.kind)}
              </div>
              {rank && (
                <div className="mt-1 text-[11px] text-slate-400">
                  {ordinalSuffix(rank.rank)} of {rank.of} ·{" "}
                  {rank.percentile}th percentile
                </div>
              )}
            </button>
          );
        })}
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              {focusMeta.label} — you vs the agency
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Your {focusMeta.label.toLowerCase()} over time compared with the
              agency&apos;s simple average (average across campaigns).
            </p>
          </div>
          <select
            value={focusMetric}
            onChange={(e) => setFocusMetric(e.target.value as MetricKey)}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
          >
            {METRIC_ORDER.map((key) => (
              <option key={key} value={key}>
                {METRIC_META[key].label}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4 h-72 w-full">
          <ResponsiveContainer>
            <LineChart
              data={trendData}
              margin={{ top: 10, right: 20, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
              <YAxis
                stroke="#94a3b8"
                fontSize={12}
                width={60}
                unit={focusMeta.kind === "rate" ? "%" : ""}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value) =>
                  formatMetricValue(
                    value == null ? null : Number(value),
                    focusMeta.kind
                  )
                }
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
              <Line
                type="monotone"
                dataKey="You"
                stroke="#fbbf24"
                strokeWidth={2.5}
                dot={{ r: 3 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="Agency avg"
                stroke="#94a3b8"
                strokeDasharray="4 4"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Where you stand — {focusMeta.label}
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Every dot is one campaign in the selected period. Your position is
          highlighted in gold.
        </p>
        <div className="mt-4">
          <DistributionStrip
            campaigns={includedCampaigns}
            metric={focusMetric}
            monthKey={selectedMonthKey}
            highlightedCampaignKey={campaign.campaignKey}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">
          All metrics
        </h2>
        <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900/30">
          <table className="min-w-full divide-y divide-white/5 text-sm">
            <thead>
              <tr className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Metric</th>
                <th className="px-3 py-3 text-right">Your value</th>
                <th className="px-3 py-3 text-right">Agency avg</th>
                <th className="px-3 py-3 text-right">Rank</th>
                <th className="px-3 py-3 text-right">Percentile</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rankSummary.map(({ key, meta, rank, value, average }) => (
                <tr key={key} className="hover:bg-white/5">
                  <td className="px-4 py-2 text-slate-200">{meta.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-100">
                    {formatMetricValue(value, meta.kind)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                    {formatMetricValue(average, meta.kind)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                    {rank ? `${rank.rank} of ${rank.of}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                    {rank ? `${rank.percentile}th` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
