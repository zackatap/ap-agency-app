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
import { KPI_INLINE_LABEL, KPI_SECTIONS, type KpiPairConfig } from "./kpi-pairs";
import type { DashboardKpiMetric } from "./data-quality";

interface Props {
  view: ClientRollupView;
  locationId: string;
  /** Pick a specific campaign at this location. Falls back to first included. */
  campaignKey?: string | null;
  /** Hide the header block (used when embedding inside the location dashboard) */
  compact?: boolean;
  /**
   * Peer campaigns flagged by the data-hygiene filter. Ranks, percentiles,
   * and peer-averages are computed over the trusted set; excluded campaigns
   * still appear on the distribution strip but drawn gray.
   */
  excludedKeys?: ReadonlySet<string>;
}

interface SeriesConfig {
  metric: MetricKey;
  label: string;
  color: string;
  /** Which y-axis this series is measured against. */
  yAxis: "left" | "right";
}

interface AxisConfig {
  /** Suffix shown on axis tick labels (e.g. "%"). Omit for mixed scales. */
  unit?: string;
  /** Prefix shown on axis tick labels (e.g. "$"). */
  prefix?: string;
}

/**
 * Metric groupings for the paired line charts. Each group can use up to two
 * y-axes (left + right) so series with different units can coexist without
 * squashing each other. Colors are chosen so each line in a group is visually
 * distinct, and the tooltip formats each value according to its own metric
 * kind (looked up from METRIC_META at render time).
 */
const CHART_GROUPS: Array<{
  id: string;
  title: string;
  subtitle: string;
  leftAxis: AxisConfig;
  rightAxis?: AxisConfig;
  series: SeriesConfig[];
}> = [
  {
    id: "leads",
    title: "Leads",
    subtitle: "Lead volume paired with cost per lead.",
    leftAxis: {},
    rightAxis: { prefix: "$" },
    series: [
      { metric: "leads", label: "Leads", color: "#818cf8", yAxis: "left" },
      { metric: "cpl", label: "Cost / Lead", color: "#fb7185", yAxis: "right" },
    ],
  },
  {
    id: "appointments",
    title: "Appointments",
    subtitle:
      "Appointments and shows with their booking / show rate percentages.",
    leftAxis: {},
    rightAxis: { unit: "%" },
    series: [
      { metric: "totalAppts", label: "Appointments", color: "#818cf8", yAxis: "left" },
      { metric: "showed", label: "Showed", color: "#34d399", yAxis: "left" },
      { metric: "bookingRate", label: "Booking rate", color: "#fbbf24", yAxis: "right" },
      { metric: "showRate", label: "Show rate", color: "#fb7185", yAxis: "right" },
    ],
  },
  {
    id: "conversions",
    title: "Conversions",
    subtitle:
      "Closed deals, close rate, ROAS, revenue, and cost per close.",
    leftAxis: {},
    rightAxis: { prefix: "$" },
    series: [
      { metric: "closed", label: "Closed", color: "#818cf8", yAxis: "left" },
      { metric: "closeRate", label: "Close rate", color: "#fbbf24", yAxis: "left" },
      { metric: "roas", label: "ROAS", color: "#a78bfa", yAxis: "left" },
      { metric: "successValue", label: "Closed value", color: "#34d399", yAxis: "right" },
      { metric: "cpClose", label: "Cost / Close", color: "#fb7185", yAxis: "right" },
    ],
  },
];

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

type RankSummaryRow = {
  key: MetricKey;
  meta: (typeof METRIC_META)[MetricKey];
  rank: ReturnType<typeof computeRank>;
  value: number | null;
  average: number | null;
};

function BenchmarkCompareColumn({
  metricKey,
  header,
  row,
  borderLeft,
}: {
  metricKey: MetricKey;
  header: string;
  row: RankSummaryRow | undefined;
  borderLeft?: boolean;
}) {
  const meta = row?.meta ?? METRIC_META[metricKey];
  const value = row?.value ?? null;
  const average = row?.average ?? null;
  const rank = row?.rank;
  const aboveAverage =
    value != null &&
    average != null &&
    ((meta.higherIsBetter && value >= average) ||
      (!meta.higherIsBetter && value <= average));

  return (
    <div
      className={`min-w-0 text-left ${
        borderLeft ? "border-l border-white/[0.04] pl-3" : "pr-3"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {header}
      </div>
      <div className="mt-1.5 border-b border-white/[0.04]" />
      <div className="pt-2 text-xl font-semibold leading-none tracking-tight text-white sm:text-2xl">
        {formatMetricValue(value, meta.kind)}
      </div>
      <div
        className={`mt-1 text-xs tabular-nums ${
          value != null && average != null
            ? aboveAverage
              ? "text-emerald-400"
              : "text-rose-400"
            : "text-slate-500"
        }`}
      >
        Avg {formatMetricValue(average, meta.kind)}
      </div>
      {rank && (
        <div className="mt-1 text-[11px] leading-snug text-slate-400">
          {ordinalSuffix(rank.rank)} of {rank.of} · {rank.percentile}th percentile
        </div>
      )}
    </div>
  );
}

function BenchmarkComparePairCard({
  pair,
  rankByKey,
}: {
  pair: KpiPairConfig;
  rankByKey: Map<MetricKey, RankSummaryRow>;
}) {
  const rowA = rankByKey.get(pair.a as MetricKey);
  const rowB = rankByKey.get(pair.b as MetricKey);

  return (
    <div
      role="group"
      aria-label={pair.cardTitle}
      className="rounded-xl border border-white/10 bg-slate-900/40 p-4"
    >
      <div className="grid grid-cols-2 gap-x-0">
        <BenchmarkCompareColumn
          metricKey={pair.a as MetricKey}
          header={KPI_INLINE_LABEL[pair.a as DashboardKpiMetric]}
          row={rowA}
        />
        <BenchmarkCompareColumn
          metricKey={pair.b as MetricKey}
          header={KPI_INLINE_LABEL[pair.b as DashboardKpiMetric]}
          row={rowB}
          borderLeft
        />
      </div>
    </div>
  );
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

export function ClientBenchmark({
  view,
  locationId,
  campaignKey,
  compact,
  excludedKeys,
}: Props) {
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
      const dist = buildDistribution(
        includedCampaigns,
        key,
        selectedMonthKey,
        excludedKeys
      );
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
  }, [campaign, includedCampaigns, selectedMonthKey, excludedKeys]);

  const rankByKey = useMemo(() => {
    const m = new Map<MetricKey, RankSummaryRow>();
    for (const row of rankSummary) {
      m.set(row.key, row);
    }
    return m;
  }, [rankSummary]);

  const isClientExcluded =
    campaign != null && excludedKeys != null && excludedKeys.has(campaign.campaignKey);

  /**
   * Build a flat per-month dataset for a Recharts LineChart that contains two
   * series per metric: `client_<metric>` and `agency_<metric>`. Downstream we
   * map this to paired solid/dashed lines with a single hue per metric.
   */
  const multiSeriesData = useMemo(() => {
    if (!campaign) return [];
    return view.months.map((m) => {
      const row: Record<string, string | number | null> = {
        monthKey: m.monthKey,
        month: formatMonthLabel(m.monthKey),
      };
      for (const key of METRIC_ORDER) {
        row[`client_${key}`] = getMonthValue(campaign.months, m.monthKey, key);
        row[`agency_${key}`] = getAgencyAvgForMonth(view.months, m.monthKey, key);
      }
      return row;
    });
  }, [campaign, view.months]);

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

      {isClientExcluded && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <span className="font-semibold">Heads up:</span> this client&apos;s
          opportunity board hasn&apos;t been kept up to date, so their
          rate/cost metrics are probably understated. Agency averages shown
          here exclude other clients with the same issue.
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

      <section className="space-y-8">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Client vs agency
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Same groupings as the agency key metrics.
          </p>
        </div>
        {KPI_SECTIONS.map((sec) => (
          <div key={sec.id} className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-white">{sec.title}</h3>
              <p className="text-xs text-slate-500">{sec.subtitle}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sec.pairs.map((pair) => (
                <BenchmarkComparePairCard
                  key={pair.id}
                  pair={pair}
                  rankByKey={rankByKey}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Client vs agency — trends
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Solid = this client · dashed = agency simple average (each campaign
            weighted equally). Metrics are grouped so related series share a
            single y-axis and are easy to compare at a glance.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {CHART_GROUPS.map((group) => (
            <GroupedComparisonChart
              key={group.id}
              title={group.title}
              subtitle={group.subtitle}
              leftAxis={group.leftAxis}
              rightAxis={group.rightAxis}
              series={group.series}
              data={multiSeriesData}
            />
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
              Where this client stands
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Every dot is one campaign in the selected period. This client&apos;s
              position is highlighted in gold.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            <span className="font-medium uppercase tracking-wide">Metric</span>
            <select
              value={focusMetric}
              onChange={(e) => setFocusMetric(e.target.value as MetricKey)}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200"
            >
              {METRIC_ORDER.map((key) => (
                <option key={key} value={key}>
                  {METRIC_META[key].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4">
          <DistributionStrip
            campaigns={includedCampaigns}
            metric={focusMetric}
            monthKey={selectedMonthKey}
            excludedKeys={excludedKeys}
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
                <th className="px-3 py-3 text-right">Client value</th>
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

interface GroupedComparisonChartProps {
  title: string;
  subtitle: string;
  leftAxis: AxisConfig;
  rightAxis?: AxisConfig;
  series: SeriesConfig[];
  data: Array<Record<string, string | number | null>>;
}

/**
 * A paired-line chart: each configured metric renders as two lines — a solid
 * line for the client and a dashed, lower-opacity line for the agency
 * simple average. Shared color per metric makes it easy to pair them up.
 *
 * Supports up to two y-axes (left + right) so series with different units
 * (counts vs %, counts vs $, etc.) can coexist without one flattening the
 * other. Tooltip values are formatted per-metric using METRIC_META.
 */
function GroupedComparisonChart({
  title,
  subtitle,
  leftAxis,
  rightAxis,
  series,
  data,
}: GroupedComparisonChartProps) {
  const hasRightAxis =
    !!rightAxis && series.some((s) => s.yAxis === "right");

  const formatTick = (cfg: AxisConfig) => (value: number) => {
    if (value == null || !Number.isFinite(value)) return "";
    const prefix = cfg.prefix ?? "";
    const unit = cfg.unit ?? "";
    // Compact money so "$12,500" doesn't push the axis too wide.
    if (prefix === "$" && Math.abs(value) >= 1000) {
      return `${prefix}${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    }
    return `${prefix}${value}${unit}`;
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-4">
      <div className="mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          {title}
        </h3>
        <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer>
          <LineChart
            data={data}
            margin={{ top: 10, right: hasRightAxis ? 8 : 12, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke="rgba(255,255,255,0.05)"
              vertical={false}
            />
            <XAxis dataKey="month" stroke="#94a3b8" fontSize={11} />
            <YAxis
              yAxisId="left"
              stroke="#94a3b8"
              fontSize={11}
              width={leftAxis.prefix === "$" ? 52 : 40}
              tickFormatter={formatTick(leftAxis)}
            />
            {hasRightAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#94a3b8"
                fontSize={11}
                width={rightAxis!.prefix === "$" ? 52 : 40}
                tickFormatter={formatTick(rightAxis!)}
              />
            )}
            <Tooltip
              wrapperStyle={{ zIndex: 50, outline: "none" }}
              contentStyle={{
                backgroundColor: "#0f172a",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value, _name, item) => {
                // Per-series formatting: derive the metric from the dataKey
                // (e.g. "client_closeRate") and look up its kind so we get
                // the right symbol/precision regardless of which axis it
                // lives on.
                const key =
                  typeof item?.dataKey === "string" ? item.dataKey : "";
                const metric = key.replace(
                  /^(client_|agency_)/,
                  ""
                ) as MetricKey;
                const meta = METRIC_META[metric];
                return formatMetricValue(
                  value == null ? null : Number(value),
                  meta?.kind ?? "count"
                );
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#cbd5e1" }}
              iconSize={8}
            />
            {series.map((s) => (
              <Line
                key={`client-${s.metric}`}
                yAxisId={s.yAxis}
                type="monotone"
                dataKey={`client_${s.metric}`}
                name={`Client · ${s.label}`}
                stroke={s.color}
                strokeWidth={2.25}
                dot={{ r: 2.5 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            {series.map((s) => (
              <Line
                key={`agency-${s.metric}`}
                yAxisId={s.yAxis}
                type="monotone"
                dataKey={`agency_${s.metric}`}
                name={`Agency · ${s.label}`}
                stroke={s.color}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                strokeOpacity={0.55}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
