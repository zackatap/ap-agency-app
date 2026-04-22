"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  ClientAgencySnapshot,
  ClientRollupView,
  MetricKey,
} from "./types";
import { METRIC_META, METRIC_ORDER } from "./metric-meta";
import {
  formatMetricValue,
  formatMonthLabel,
} from "./format";
import { MonthlyTotalsChart } from "./monthly-totals-chart";
import { RatesChart } from "./rates-chart";
import { DistributionStrip } from "./distribution-strip";
import { LeaderboardTable } from "./leaderboard-table";
import { RefreshControls } from "./refresh-controls";
import { ClientBenchmark } from "./client-benchmark";
import { ClientMap } from "./client-map";
import {
  aggregateCampaignWindow,
  type FilteredAggregate,
  buildExcludedSet,
  type ExclusionLevel,
} from "./data-quality";
import {
  DATE_RANGE_LABELS,
  type DateRangePreset,
  getTodayLocal,
} from "@/lib/date-ranges";

interface Props {
  initial: ClientRollupView | null;
  initialLatest: ClientAgencySnapshot | null;
}

type DashboardTab = "performance" | "map";

function delta(
  current: number | null | undefined,
  previous: number | null | undefined
): { diff: number; pct: number | null } | null {
  if (current == null) return null;
  if (previous == null) return { diff: current, pct: null };
  const diff = current - previous;
  const pct = previous === 0 ? null : Math.round((diff / previous) * 1000) / 10;
  return { diff, pct };
}

interface KpiProps {
  label: string;
  value: string;
  sub?: string;
  diff?: { diff: number; pct: number | null } | null;
  better: "up" | "down";
  kind: "count" | "money" | "rate" | "ratio";
}

function Kpi({ label, value, sub, diff, better, kind }: KpiProps) {
  const up = diff != null && diff.diff > 0;
  const down = diff != null && diff.diff < 0;
  const good = (up && better === "up") || (down && better === "down");
  const color = diff == null
    ? "text-slate-400"
    : up || down
      ? good
        ? "text-emerald-400"
        : "text-rose-400"
      : "text-slate-400";

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
      {diff != null && (
        <div className={`mt-2 text-xs ${color}`}>
          {diff.diff > 0 ? "▲" : diff.diff < 0 ? "▼" : "•"}{" "}
          {formatMetricValue(Math.abs(diff.diff), kind)}
          {diff.pct != null && (
            <span className="ml-1 text-[11px] opacity-80">
              ({diff.pct > 0 ? "+" : ""}
              {diff.pct.toFixed(1)}%)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Count/money SUMS (leads, appts, showed, closed, value, spend) are totals
 * across every included campaign so the displayed numbers don't quietly
 * shrink when the hygiene toggle is flipped.
 *
 * RATES and COST RATIOS (booking/show/close rate, ROAS, CPL, cost-per-close)
 * use a **simple average across trusted campaigns**: each campaign computes
 * its own rate over the window (server-side, same formula the individual
 * dashboard uses), and every client gets one equal vote. A 3,000-lead client
 * doesn't drown out a 300-lead client.
 */
function buildKpiCards(
  sums: FilteredAggregate,
  priorSums: FilteredAggregate,
  rates: FilteredAggregate,
  priorRates: FilteredAggregate
): KpiProps[] {
  const avgSub = "Avg across clients";
  return [
    {
      label: "Leads",
      value: formatMetricValue(sums.leads, "count"),
      diff: delta(sums.leads, priorSums.leads),
      better: "up",
      kind: "count",
    },
    {
      label: "Appointments",
      value: formatMetricValue(sums.totalAppts, "count"),
      diff: delta(sums.totalAppts, priorSums.totalAppts),
      better: "up",
      kind: "count",
    },
    {
      label: "Showed",
      value: formatMetricValue(sums.showed, "count"),
      diff: delta(sums.showed, priorSums.showed),
      better: "up",
      kind: "count",
    },
    {
      label: "Closed",
      value: formatMetricValue(sums.closed, "count"),
      diff: delta(sums.closed, priorSums.closed),
      better: "up",
      kind: "count",
    },
    {
      label: "Booking rate",
      value: formatMetricValue(rates.bookingRate, "rate"),
      sub: avgSub,
      diff: delta(rates.bookingRate, priorRates.bookingRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "Show rate",
      value: formatMetricValue(rates.showRate, "rate"),
      sub: avgSub,
      diff: delta(rates.showRate, priorRates.showRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "Close rate",
      value: formatMetricValue(rates.closeRate, "rate"),
      sub: avgSub,
      diff: delta(rates.closeRate, priorRates.closeRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "ROAS",
      value: formatMetricValue(rates.roas, "ratio"),
      sub: avgSub,
      diff: delta(rates.roas, priorRates.roas),
      better: "up",
      kind: "ratio",
    },
    {
      label: "Closed value",
      value: formatMetricValue(sums.successValue, "money"),
      diff: delta(sums.successValue, priorSums.successValue),
      better: "up",
      kind: "money",
    },
    {
      label: "Ad spend",
      value: formatMetricValue(sums.adSpend, "money"),
      diff: delta(sums.adSpend, priorSums.adSpend),
      better: "down",
      kind: "money",
    },
    {
      label: "Cost / Lead",
      value: formatMetricValue(rates.cpl, "money"),
      sub: avgSub,
      diff: delta(rates.cpl, priorRates.cpl),
      better: "down",
      kind: "money",
    },
    {
      label: "Cost / Close",
      value: formatMetricValue(rates.cpClose, "money"),
      sub: avgSub,
      diff: delta(rates.cpClose, priorRates.cpClose),
      better: "down",
      kind: "money",
    },
  ];
}

const EXCLUSION_OPTIONS: Array<{
  value: ExclusionLevel;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "Off",
    description: "Every campaign counts toward agency averages.",
  },
  {
    value: "light",
    label: "Light",
    description:
      "Only exclude campaigns with <5% funnel movement or 80%+ of open appts untouched for 21+ days.",
  },
  {
    value: "moderate",
    label: "Moderate",
    description:
      "Exclude campaigns with <25% funnel movement or >50% stale-open backlog.",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    description:
      "Exclude campaigns with <50% funnel movement or >30% stale-open backlog.",
  },
];

const DATE_RANGE_ORDER: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

function formatRangeLabel(
  preset: DateRangePreset,
  startDate: string,
  endDate: string
): string {
  const label = DATE_RANGE_LABELS[preset];
  if (preset === "maximum") return "All time";
  return `${label} · ${startDate} → ${endDate}`;
}

export function AgencyDashboard({ initial, initialLatest }: Props) {
  const [view, setView] = useState<ClientRollupView | null>(initial);
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | "total">(
    () => initial?.months[initial.months.length - 1]?.monthKey ?? "total"
  );
  const [distributionMetric, setDistributionMetric] = useState<MetricKey>("closed");
  const [ratesMode, setRatesMode] = useState<"simple" | "weighted">("simple");
  const [compareCampaignKey, setCompareCampaignKey] = useState<string | "">("");
  const [exclusionLevel, setExclusionLevel] = useState<ExclusionLevel>("moderate");
  const [currentLatest, setCurrentLatest] = useState<ClientAgencySnapshot | null>(
    initialLatest
  );
  const [activeTab, setActiveTab] = useState<DashboardTab>("performance");

  // Date range state — mirrors the client dashboard (select + optional custom
  // from/to + Apply button for custom).
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>(
    () => (initial?.range.preset as DateRangePreset) ?? "last_30"
  );
  const [customDateFrom, setCustomDateFrom] = useState<string>(
    () => (initial?.range.preset === "custom" ? initial.range.startDate : "")
  );
  const [customDateTo, setCustomDateTo] = useState<string>(
    () => (initial?.range.preset === "custom" ? initial.range.endDate : "")
  );
  const [rangeLoading, setRangeLoading] = useState(false);
  /** Funnel count semantics — matches the client dashboard rollup toggle (default on). */
  const [onTotals, setOnTotals] = useState(
    () => initial?.onTotals !== false
  );

  const leaderboardRef = useRef<HTMLElement | null>(null);
  const selectCampaignForCompare = (campaignKey: string) => {
    setCompareCampaignKey(campaignKey);
    leaderboardRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  /**
   * Fetch the latest rollup view for a given date-range preset. Custom ranges
   * require both `from` and `to` to be set — we skip the fetch otherwise
   * (mirroring the client dashboard's "Apply" button behavior).
   */
  const fetchRollup = useCallback(
    async (
      preset: DateRangePreset,
      from?: string,
      to?: string,
      onTotalsOverride?: boolean
    ) => {
      const ot = onTotalsOverride ?? onTotals;
      const params = new URLSearchParams();
      params.set("preset", preset);
      params.set("clientDate", getTodayLocal());
      if (!ot) params.set("onTotals", "false");
      if (preset === "custom") {
        if (!from || !to) return;
        params.set("from", from);
        params.set("to", to);
      }
      setRangeLoading(true);
      try {
        const res = await fetch(
          `/api/agency/rollup/latest?${params.toString()}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const body = (await res.json()) as ClientRollupView & {
          message?: string;
        };
        if (body.snapshot) {
          setView(body);
          setSelectedMonthKey(
            body.months[body.months.length - 1]?.monthKey ?? "total"
          );
        } else {
          setView(null);
        }
      } catch {
        // ignore
      } finally {
        setRangeLoading(false);
      }
    },
    [onTotals]
  );

  const reloadSnapshot = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/agency/rollup/status", {
        cache: "no-store",
      });
      if (statusRes.ok) {
        const body = (await statusRes.json()) as {
          latest: ClientAgencySnapshot | null;
        };
        setCurrentLatest(body.latest);
      }
    } catch {
      // ignore
    }
    // Re-pull the range view using the current preset so new snapshot data
    // flows through immediately.
    await fetchRollup(dateRangePreset, customDateFrom, customDateTo);
  }, [dateRangePreset, customDateFrom, customDateTo, fetchRollup]);

  useEffect(() => {
    if (!currentLatest || currentLatest.status !== "running") return;
    const id = setInterval(reloadSnapshot, 15_000);
    return () => clearInterval(id);
  }, [currentLatest, reloadSnapshot]);

  const handleDateRangeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const preset = e.target.value as DateRangePreset;
    setDateRangePreset(preset);
    if (preset === "custom") return;
    fetchRollup(preset);
  };

  const handleCustomDateApply = () => {
    if (!customDateFrom || !customDateTo) return;
    fetchRollup("custom", customDateFrom, customDateTo);
  };

  const handleOnTotalsModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value === "onTotals";
    setOnTotals(v);
    if (dateRangePreset === "custom" && (!customDateFrom || !customDateTo)) return;
    void fetchRollup(dateRangePreset, customDateFrom, customDateTo, v);
  };

  const campaigns = view?.campaigns ?? [];
  const includedCampaigns = useMemo(
    () => campaigns.filter((c) => c.included),
    [campaigns]
  );

  // Data-hygiene exclusion: some clients don't move appts forward on their
  // opportunity board. They're included in the total counts (they still
  // produce leads/appts) but excluded from rate-based metrics/averages.
  const excludedMap = useMemo(
    () =>
      buildExcludedSet(
        includedCampaigns,
        exclusionLevel,
        view?.onTotals !== false
      ),
    [includedCampaigns, exclusionLevel, view?.onTotals]
  );
  const excludedKeys = useMemo(
    () => new Set(excludedMap.keys()),
    [excludedMap]
  );
  const trustedCampaigns = useMemo(
    () => includedCampaigns.filter((c) => !excludedKeys.has(c.campaignKey)),
    [includedCampaigns, excludedKeys]
  );

  const months = view?.months ?? [];

  // Count sums come from ALL included campaigns over the selected range.
  const currentSums = useMemo(
    () => aggregateCampaignWindow(includedCampaigns, "totals"),
    [includedCampaigns]
  );
  const priorSums = useMemo(
    () => aggregateCampaignWindow(includedCampaigns, "priorTotals"),
    [includedCampaigns]
  );
  // Rate KPIs use the TRUSTED subset — one vote per campaign.
  const currentRates = useMemo(
    () => aggregateCampaignWindow(trustedCampaigns, "totals"),
    [trustedCampaigns]
  );
  const priorRates = useMemo(
    () => aggregateCampaignWindow(trustedCampaigns, "priorTotals"),
    [trustedCampaigns]
  );

  const kpiCards = useMemo(
    () => buildKpiCards(currentSums, priorSums, currentRates, priorRates),
    [currentSums, priorSums, currentRates, priorRates]
  );

  const activeLocationCount = useMemo(() => {
    const set = new Set<string>();
    for (const c of includedCampaigns) set.add(c.locationId);
    return set.size;
  }, [includedCampaigns]);

  // Number of campaigns that actually reported at least one signal over the
  // selected window. Used as the "X/Y campaigns reporting" stat.
  const reportingCampaignCount = useMemo(() => {
    let n = 0;
    for (const c of includedCampaigns) {
      const t = c.totals;
      if (
        t.leads > 0 ||
        t.totalAppts > 0 ||
        t.showed > 0 ||
        t.closed > 0 ||
        t.noShow > 0 ||
        t.adSpend > 0 ||
        t.successValue > 0
      ) {
        n += 1;
      }
    }
    return n;
  }, [includedCampaigns]);

  const latestSnapshotFinished =
    view?.snapshot.finishedAt ?? initial?.snapshot.finishedAt ?? null;

  const currentRangeLabel = view
    ? formatRangeLabel(
        (view.range.preset as DateRangePreset) ?? "last_30",
        view.range.startDate,
        view.range.endDate
      )
    : "—";
  const priorRangeLabel = view
    ? `${view.priorRange.startDate} → ${view.priorRange.endDate}`
    : "—";

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">
            Agency rollup
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {activeTab === "performance"
              ? "Performance across every active & 2nd campaign client. Each sheet row is its own campaign; clients with ACTIVE + 2ND CMPN show both pipelines rolled up under their CID."
              : "Every client from the Client DB sheet plotted on a map. Filter by status to focus the view; each pin is one client even when they have multiple campaigns."}
          </p>
        </div>
        {activeTab === "performance" && (
          <RefreshControls
            latest={currentLatest}
            completeFinishedAt={latestSnapshotFinished}
            onRefreshFinished={reloadSnapshot}
          />
        )}
      </header>

      <nav className="flex items-center gap-1 rounded-xl border border-white/10 bg-slate-900/40 p-1 text-sm">
        {(
          [
            { id: "performance", label: "Performance" },
            { id: "map", label: "Client map" },
          ] as Array<{ id: DashboardTab; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-4 py-1.5 transition-colors ${
              activeTab === tab.id
                ? "bg-indigo-600 text-white"
                : "text-slate-300 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "map" && <ClientMap />}

      {activeTab === "performance" && !view && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          <p className="text-lg font-medium">No rollup data yet</p>
          <p className="mt-2 text-sm text-slate-400">
            Click <span className="font-semibold text-white">Refresh data</span>{" "}
            in the header to generate the first snapshot. This typically takes
            1–3 minutes depending on how many clients you have.
          </p>
        </div>
      )}

      {activeTab === "performance" && view && (
        <>
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  Showing
                </div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {currentRangeLabel}
                  {rangeLoading && (
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      loading…
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  Compared with{" "}
                  <span className="text-slate-300">{priorRangeLabel}</span>
                  {" · "}
                  {reportingCampaignCount}/{campaigns.length} campaigns
                  reporting · {activeLocationCount} locations
                  {excludedKeys.size > 0 && (
                    <>
                      {" · "}
                      <span className="text-amber-300">
                        {excludedKeys.size} excluded from rates
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Date range
                  </label>
                  <select
                    value={dateRangePreset}
                    onChange={handleDateRangeChange}
                    disabled={rangeLoading}
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    {DATE_RANGE_ORDER.map((p) => (
                      <option
                        key={p}
                        value={p}
                        className="bg-slate-900 text-white"
                      >
                        {DATE_RANGE_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Funnel totals
                  </label>
                  <select
                    value={onTotals ? "onTotals" : "currentStage"}
                    onChange={handleOnTotalsModeChange}
                    disabled={rangeLoading}
                    title="On Totals counts each opportunity in every stage it reached (matches the client dashboard). Current stage only counts each opportunity once, in its present stage."
                    className="max-w-[200px] rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="onTotals" className="bg-slate-900">
                      On Totals
                    </option>
                    <option value="currentStage" className="bg-slate-900">
                      Current stage only
                    </option>
                  </select>
                </div>
                {dateRangePreset === "custom" && (
                  <div className="flex items-end gap-2">
                    <div>
                      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                        From
                      </label>
                      <input
                        type="date"
                        value={customDateFrom}
                        onChange={(e) => setCustomDateFrom(e.target.value)}
                        className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                        To
                      </label>
                      <input
                        type="date"
                        value={customDateTo}
                        onChange={(e) => setCustomDateTo(e.target.value)}
                        className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleCustomDateApply}
                      disabled={
                        !customDateFrom || !customDateTo || rangeLoading
                      }
                      className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/30 px-4 py-3 text-xs text-slate-300">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold uppercase tracking-wide text-slate-400">
                  Data hygiene filter
                </span>
                <span className="text-slate-500">
                  {
                    EXCLUSION_OPTIONS.find((o) => o.value === exclusionLevel)
                      ?.description
                  }
                </span>
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-slate-800/50 p-1">
                {EXCLUSION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setExclusionLevel(opt.value)}
                    className={`rounded-md px-3 py-1 transition-colors ${
                      exclusionLevel === opt.value
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:text-white"
                    }`}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {kpiCards.map((card, idx) => (
                <Kpi key={idx} {...card} />
              ))}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Agency totals per month
                </h2>
                <span className="text-xs text-slate-500">
                  {months.length} months
                </span>
              </div>
              <div className="mt-4">
                <MonthlyTotalsChart months={months} />
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Conversion rates
                </h2>
                <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 p-1 text-xs">
                  <button
                    onClick={() => setRatesMode("simple")}
                    className={`rounded-md px-3 py-1 transition-colors ${
                      ratesMode === "simple"
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:text-white"
                    }`}
                    title="Average of each campaign's rate (campaigns weighted equally)"
                  >
                    Simple avg
                  </button>
                  <button
                    onClick={() => setRatesMode("weighted")}
                    className={`rounded-md px-3 py-1 transition-colors ${
                      ratesMode === "weighted"
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:text-white"
                    }`}
                    title="Sum across all campaigns (big accounts dominate)"
                  >
                    Weighted
                  </button>
                </div>
              </div>
              <div className="mt-4">
                <RatesChart months={months} mode={ratesMode} />
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Campaign distribution
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={distributionMetric}
                  onChange={(e) =>
                    setDistributionMetric(e.target.value as MetricKey)
                  }
                  className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-slate-200"
                >
                  {METRIC_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {METRIC_META[key].label}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedMonthKey}
                  onChange={(e) =>
                    setSelectedMonthKey(
                      e.target.value as string | "total"
                    )
                  }
                  className="rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-slate-200"
                >
                  <option value="total">Selected date range</option>
                  {months.map((m) => (
                    <option key={m.monthKey} value={m.monthKey}>
                      {formatMonthLabel(m.monthKey)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Each dot is one campaign. The indigo bar covers the middle 50%
              of campaigns; the vertical line is the agency average. Click any
              dot to open that campaign&apos;s benchmark.
            </p>
            <div className="mt-4">
              <DistributionStrip
                campaigns={includedCampaigns}
                metric={distributionMetric}
                monthKey={selectedMonthKey}
                excludedKeys={excludedKeys}
                highlightedCampaignKey={compareCampaignKey || undefined}
                onSelect={(campaign) =>
                  selectCampaignForCompare(campaign.campaignKey)
                }
              />
            </div>
          </section>

          <section ref={leaderboardRef} className="scroll-mt-8 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Client leaderboard
              </h2>
              <p className="text-xs text-slate-500">
                Click <span className="text-slate-300">Compare</span> on any
                row to see that client benchmarked against the agency inline.
              </p>
            </div>
            <LeaderboardTable
              campaigns={includedCampaigns}
              monthKey={selectedMonthKey}
              excludedKeys={excludedKeys}
              compareCampaignKey={compareCampaignKey || null}
              onCompareCampaignKeyChange={(key) =>
                setCompareCampaignKey(key ?? "")
              }
              renderCompare={(campaign) =>
                view ? (
                  <ClientBenchmark
                    key={campaign.campaignKey}
                    view={view}
                    locationId={campaign.locationId}
                    campaignKey={campaign.campaignKey}
                    excludedKeys={excludedKeys}
                    compact
                  />
                ) : null
              }
            />
          </section>

          <section className="space-y-2 text-xs text-slate-500">
            <div>
              Snapshot #{view.snapshot.id} ·{" "}
              {view.snapshot.clientsIncluded} campaigns included ·{" "}
              {view.snapshot.clientsFailed} excluded ·{" "}
              {view.snapshot.monthsCovered} months
            </div>
            {view.snapshot.errors.length > 0 && (
              <details className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
                <summary className="cursor-pointer text-sm text-slate-300">
                  {view.snapshot.errors.length} campaigns could not be
                  included — click for details
                </summary>
                <ul className="mt-3 space-y-1 text-xs text-slate-400">
                  {view.snapshot.errors.map((err, i) => (
                    <li key={i} className="flex flex-col">
                      <span className="font-medium text-slate-200">
                        {err.businessName ?? err.locationId ?? "Unknown"}
                      </span>
                      <span>{err.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div>
              <Link
                href="/api/agency/auth/logout"
                onClick={(e) => {
                  e.preventDefault();
                  fetch("/api/agency/auth/logout", { method: "POST" }).then(
                    () => (window.location.href = "/agency/login")
                  );
                }}
                className="underline hover:text-slate-300"
              >
                Sign out
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
