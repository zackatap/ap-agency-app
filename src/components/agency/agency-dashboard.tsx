"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  ClientAgencySnapshot,
  ClientMonthTotals,
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
import {
  aggregateCampaignsOverMonths,
  buildExcludedSet,
  type ExclusionLevel,
} from "./data-quality";

interface Props {
  initial: ClientRollupView | null;
  initialLatest: ClientAgencySnapshot | null;
}

type PeriodSize = 1 | 3 | 6 | 12;

interface WindowAggregate {
  monthsCount: number;
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
  /** Peak of `clientCount` during the window — the number of campaigns
   *  that reported at least one signal in their best month. */
  peakCampaignCount: number;
}

function aggregateWindow(slice: ClientMonthTotals[]): WindowAggregate {
  const base = {
    monthsCount: slice.length,
    leads: 0,
    totalAppts: 0,
    showed: 0,
    closed: 0,
    totalValue: 0,
    successValue: 0,
    adSpend: 0,
    peakCampaignCount: 0,
  };
  for (const m of slice) {
    base.leads += m.leads;
    base.totalAppts += m.totalAppts;
    base.showed += m.showed;
    base.closed += m.closed;
    base.totalValue += m.totalValue;
    base.successValue += m.successValue;
    base.adSpend += m.adSpend;
    if (m.clientCount > base.peakCampaignCount) {
      base.peakCampaignCount = m.clientCount;
    }
  }
  const leadPool = base.leads + base.totalAppts + base.showed + base.closed;
  const apptPool = base.totalAppts + base.showed + base.closed;
  const showPool = base.showed + base.closed;
  return {
    ...base,
    bookingRate:
      leadPool > 0
        ? Math.round(((apptPool) / leadPool) * 1000) / 10
        : null,
    showRate:
      apptPool > 0 ? Math.round((showPool / apptPool) * 1000) / 10 : null,
    closeRate:
      showPool > 0 ? Math.round((base.closed / showPool) * 1000) / 10 : null,
    cpl:
      base.adSpend > 0 && base.leads > 0
        ? Math.round((base.adSpend / base.leads) * 100) / 100
        : null,
    cps:
      base.adSpend > 0 && base.showed > 0
        ? Math.round((base.adSpend / base.showed) * 100) / 100
        : null,
    cpClose:
      base.adSpend > 0 && base.closed > 0
        ? Math.round((base.adSpend / base.closed) * 100) / 100
        : null,
    roas:
      base.adSpend > 0
        ? Math.round((base.successValue / base.adSpend) * 100) / 100
        : null,
  };
}

function getWindowSlices(
  months: ClientMonthTotals[],
  period: PeriodSize
): { current: ClientMonthTotals[]; prior: ClientMonthTotals[] } {
  if (months.length === 0) return { current: [], prior: [] };
  const n = Math.min(period, months.length);
  const current = months.slice(months.length - n, months.length);
  const priorEnd = months.length - n;
  const priorStart = Math.max(0, priorEnd - n);
  const prior = months.slice(priorStart, priorEnd);
  return { current, prior };
}

function describePeriodRange(slice: ClientMonthTotals[]): string {
  if (slice.length === 0) return "—";
  if (slice.length === 1) return formatMonthLabel(slice[0].monthKey);
  return `${formatMonthLabel(slice[0].monthKey)} – ${formatMonthLabel(slice[slice.length - 1].monthKey)}`;
}

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

const PERIOD_OPTIONS: Array<{ value: PeriodSize; label: string }> = [
  { value: 1, label: "Latest month" },
  { value: 3, label: "Last 3 months" },
  { value: 6, label: "Last 6 months" },
  { value: 12, label: "Last 12 months" },
];

interface RateAggregate {
  bookingRate: number | null;
  showRate: number | null;
  closeRate: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
  roas: number | null;
}

/**
 * Count-sum metrics (leads/appts/showed/closed/value/spend) come from the
 * full pool — "total leads across the agency" must always include every
 * campaign so the numbers don't quietly shrink when the hygiene toggle is
 * flipped. Rate/cost-efficiency metrics pull from `rates`, which is
 * recomputed from only the trusted (non-excluded) campaigns.
 */
function buildKpiCards(
  current: WindowAggregate,
  prior: WindowAggregate,
  currentRates: RateAggregate,
  priorRates: RateAggregate
): KpiProps[] {
  return [
    {
      label: "Leads",
      value: formatMetricValue(current.leads, "count"),
      diff: delta(current.leads, prior.leads),
      better: "up",
      kind: "count",
    },
    {
      label: "Appointments",
      value: formatMetricValue(current.totalAppts, "count"),
      diff: delta(current.totalAppts, prior.totalAppts),
      better: "up",
      kind: "count",
    },
    {
      label: "Showed",
      value: formatMetricValue(current.showed, "count"),
      diff: delta(current.showed, prior.showed),
      better: "up",
      kind: "count",
    },
    {
      label: "Closed",
      value: formatMetricValue(current.closed, "count"),
      diff: delta(current.closed, prior.closed),
      better: "up",
      kind: "count",
    },
    {
      label: "Booking rate",
      value: formatMetricValue(currentRates.bookingRate, "rate"),
      diff: delta(currentRates.bookingRate, priorRates.bookingRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "Show rate",
      value: formatMetricValue(currentRates.showRate, "rate"),
      diff: delta(currentRates.showRate, priorRates.showRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "Close rate",
      value: formatMetricValue(currentRates.closeRate, "rate"),
      diff: delta(currentRates.closeRate, priorRates.closeRate),
      better: "up",
      kind: "rate",
    },
    {
      label: "ROAS",
      value: formatMetricValue(currentRates.roas, "ratio"),
      diff: delta(currentRates.roas, priorRates.roas),
      better: "up",
      kind: "ratio",
    },
    {
      label: "Closed value",
      value: formatMetricValue(current.successValue, "money"),
      diff: delta(current.successValue, prior.successValue),
      better: "up",
      kind: "money",
    },
    {
      label: "Ad spend",
      value: formatMetricValue(current.adSpend, "money"),
      diff: delta(current.adSpend, prior.adSpend),
      better: "down",
      kind: "money",
    },
    {
      label: "Cost / Lead",
      value: formatMetricValue(currentRates.cpl, "money"),
      diff: delta(currentRates.cpl, priorRates.cpl),
      better: "down",
      kind: "money",
    },
    {
      label: "Cost / Close",
      value: formatMetricValue(currentRates.cpClose, "money"),
      diff: delta(currentRates.cpClose, priorRates.cpClose),
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

export function AgencyDashboard({ initial, initialLatest }: Props) {
  const [view, setView] = useState<ClientRollupView | null>(initial);
  const [period, setPeriod] = useState<PeriodSize>(1);
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
  const leaderboardRef = useRef<HTMLElement | null>(null);
  const selectCampaignForCompare = (campaignKey: string) => {
    setCompareCampaignKey(campaignKey);
    leaderboardRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const reloadSnapshot = async () => {
    try {
      const [viewRes, statusRes] = await Promise.all([
        fetch("/api/agency/rollup/latest", { cache: "no-store" }),
        fetch("/api/agency/rollup/status", { cache: "no-store" }),
      ]);
      if (viewRes.ok) {
        const body = (await viewRes.json()) as ClientRollupView & {
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
      }
      if (statusRes.ok) {
        const body = (await statusRes.json()) as {
          latest: ClientAgencySnapshot | null;
        };
        setCurrentLatest(body.latest);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!currentLatest || currentLatest.status !== "running") return;
    const id = setInterval(reloadSnapshot, 15_000);
    return () => clearInterval(id);
  }, [currentLatest]);

  const campaigns = view?.campaigns ?? [];
  const includedCampaigns = useMemo(
    () => campaigns.filter((c) => c.included),
    [campaigns]
  );

  // Data-hygiene exclusion: some clients don't move appts forward on their
  // opportunity board. They're included in the total counts (they still
  // produce leads/appts) but excluded from rate-based metrics/averages.
  const excludedMap = useMemo(
    () => buildExcludedSet(includedCampaigns, exclusionLevel),
    [includedCampaigns, exclusionLevel]
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

  const { current: currentSlice, prior: priorSlice } = useMemo(
    () => getWindowSlices(months, period),
    [months, period]
  );
  const currentAggregate = useMemo(
    () => aggregateWindow(currentSlice),
    [currentSlice]
  );
  const priorAggregate = useMemo(() => aggregateWindow(priorSlice), [priorSlice]);

  // Rate KPIs are pooled over the TRUSTED campaign subset; count sums stay
  // on the full pool so "Total Leads" always matches the underlying data.
  const currentRateAggregate = useMemo(
    () =>
      aggregateCampaignsOverMonths(
        trustedCampaigns,
        currentSlice.map((m) => m.monthKey)
      ),
    [trustedCampaigns, currentSlice]
  );
  const priorRateAggregate = useMemo(
    () =>
      aggregateCampaignsOverMonths(
        trustedCampaigns,
        priorSlice.map((m) => m.monthKey)
      ),
    [trustedCampaigns, priorSlice]
  );
  const kpiCards = useMemo(
    () =>
      buildKpiCards(
        currentAggregate,
        priorAggregate,
        currentRateAggregate,
        priorRateAggregate
      ),
    [currentAggregate, priorAggregate, currentRateAggregate, priorRateAggregate]
  );

  const compareCampaign = useMemo(
    () =>
      campaigns.find((c) => c.campaignKey === compareCampaignKey) ?? null,
    [campaigns, compareCampaignKey]
  );

  const activeLocationCount = useMemo(() => {
    const set = new Set<string>();
    for (const c of includedCampaigns) set.add(c.locationId);
    return set.size;
  }, [includedCampaigns]);

  const latestSnapshotFinished =
    view?.snapshot.finishedAt ?? initial?.snapshot.finishedAt ?? null;

  const currentRangeLabel = describePeriodRange(currentSlice);
  const priorRangeLabel = describePeriodRange(priorSlice);
  const hasPriorWindow = priorSlice.length > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">
            Agency rollup
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Performance across every active &amp; 2nd campaign client. Each sheet
            row is its own campaign; clients with ACTIVE + 2ND CMPN show both
            pipelines rolled up under their CID.
          </p>
        </div>
        <RefreshControls
          latest={currentLatest}
          completeFinishedAt={latestSnapshotFinished}
          onRefreshFinished={reloadSnapshot}
        />
      </header>

      {!view && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          <p className="text-lg font-medium">No rollup data yet</p>
          <p className="mt-2 text-sm text-slate-400">
            Click <span className="font-semibold text-white">Refresh data</span>{" "}
            in the header to generate the first snapshot. This typically takes
            1–3 minutes depending on how many clients you have.
          </p>
        </div>
      )}

      {view && (
        <>
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  Showing
                </div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {currentRangeLabel}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {hasPriorWindow ? (
                    <>
                      Compared with{" "}
                      <span className="text-slate-300">{priorRangeLabel}</span>{" "}
                      · {currentAggregate.peakCampaignCount}/{campaigns.length}{" "}
                      campaigns reporting · {activeLocationCount} locations
                    </>
                  ) : (
                    <>
                      Not enough history for a comparison window ·{" "}
                      {currentAggregate.peakCampaignCount}/{campaigns.length}{" "}
                      campaigns reporting
                    </>
                  )}
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
              <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 p-1 text-xs">
                {PERIOD_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPeriod(opt.value)}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      period === opt.value
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
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
                  <option value="total">13-month total</option>
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
                highlightedCampaignKey={
                  compareCampaign?.campaignKey ?? undefined
                }
                onSelect={(campaign) => selectCampaignForCompare(campaign.campaignKey)}
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
