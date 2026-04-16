"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  ClientAgencySnapshot,
  ClientLocationSummary,
  ClientRollupView,
  MetricKey,
} from "./types";
import { METRIC_META, METRIC_ORDER } from "./metric-meta";
import { formatMetricValue, formatMonthLabel } from "./format";
import { MonthlyTotalsChart } from "./monthly-totals-chart";
import { RatesChart } from "./rates-chart";
import { DistributionStrip } from "./distribution-strip";
import { LeaderboardTable } from "./leaderboard-table";
import { RefreshControls } from "./refresh-controls";

interface Props {
  initial: ClientRollupView | null;
  initialLatest: ClientAgencySnapshot | null;
}

type ViewMode = "location" | "cid";

function grouping(locations: ClientLocationSummary[], mode: ViewMode) {
  if (mode === "location") return locations;
  const byCid = new Map<string, ClientLocationSummary[]>();
  for (const loc of locations) {
    const key = loc.cid?.trim() || `loc:${loc.locationId}`;
    const list = byCid.get(key) ?? [];
    list.push(loc);
    byCid.set(key, list);
  }
  const grouped: ClientLocationSummary[] = [];
  for (const [key, items] of byCid.entries()) {
    if (items.length === 1) {
      grouped.push(items[0]);
      continue;
    }
    const included = items.every((i) => i.included);
    const first = items[0];
    const monthKeys = first.months.map((m) => m.monthKey);
    const months = monthKeys.map((mk) => {
      let leads = 0,
        totalAppts = 0,
        showed = 0,
        closed = 0,
        totalValue = 0,
        successValue = 0,
        adSpend = 0;
      for (const it of items) {
        const m = it.months.find((mm) => mm.monthKey === mk);
        if (!m) continue;
        leads += m.leads;
        totalAppts += m.totalAppts;
        showed += m.showed;
        closed += m.closed;
        totalValue += m.totalValue;
        successValue += m.successValue;
        adSpend += m.adSpend;
      }
      const pool = leads + totalAppts + showed + closed;
      const bookingRate =
        pool > 0 ? Math.round(((totalAppts + showed + closed) / pool) * 1000) / 10 : null;
      const apptPool = totalAppts + showed + closed;
      const showRate =
        apptPool > 0 ? Math.round(((showed + closed) / apptPool) * 1000) / 10 : null;
      const closePool = showed + closed;
      const closeRate =
        closePool > 0 ? Math.round((closed / closePool) * 1000) / 10 : null;
      return {
        monthKey: mk,
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
        cpl: adSpend > 0 && leads > 0 ? Math.round((adSpend / leads) * 100) / 100 : null,
        cps:
          adSpend > 0 && showed > 0 ? Math.round((adSpend / showed) * 100) / 100 : null,
        cpClose:
          adSpend > 0 && closed > 0 ? Math.round((adSpend / closed) * 100) / 100 : null,
        roas:
          adSpend > 0 ? Math.round((successValue / adSpend) * 100) / 100 : null,
      };
    });
    const totals = months.reduce(
      (acc, m) => ({
        leads: acc.leads + m.leads,
        totalAppts: acc.totalAppts + m.totalAppts,
        showed: acc.showed + m.showed,
        closed: acc.closed + m.closed,
        totalValue: acc.totalValue + m.totalValue,
        successValue: acc.successValue + m.successValue,
        adSpend: acc.adSpend + m.adSpend,
      }),
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
    const pool = totals.leads + totals.totalAppts + totals.showed + totals.closed;
    const apptPool = totals.totalAppts + totals.showed + totals.closed;
    const closePool = totals.showed + totals.closed;
    const combined: ClientLocationSummary = {
      locationId: `cid:${key}`,
      cid: first.cid,
      businessName: first.cid
        ? `CID ${first.cid} (${items.length} locations)`
        : first.businessName,
      ownerName: first.ownerName,
      statuses: [...new Set(items.flatMap((i) => i.statuses))],
      pipelineName: null,
      included,
      errorMessage: null,
      totals: {
        ...totals,
        bookingRate:
          pool > 0
            ? Math.round(
                ((totals.totalAppts + totals.showed + totals.closed) / pool) * 1000
              ) / 10
            : null,
        showRate:
          apptPool > 0
            ? Math.round(((totals.showed + totals.closed) / apptPool) * 1000) / 10
            : null,
        closeRate:
          closePool > 0
            ? Math.round((totals.closed / closePool) * 1000) / 10
            : null,
        cpl:
          totals.adSpend > 0 && totals.leads > 0
            ? Math.round((totals.adSpend / totals.leads) * 100) / 100
            : null,
        cps:
          totals.adSpend > 0 && totals.showed > 0
            ? Math.round((totals.adSpend / totals.showed) * 100) / 100
            : null,
        cpClose:
          totals.adSpend > 0 && totals.closed > 0
            ? Math.round((totals.adSpend / totals.closed) * 100) / 100
            : null,
        roas:
          totals.adSpend > 0
            ? Math.round((totals.successValue / totals.adSpend) * 100) / 100
            : null,
      },
      latestMonth: months[months.length - 1] ?? null,
      months,
    };
    grouped.push(combined);
  }
  grouped.sort((a, b) => a.businessName.localeCompare(b.businessName));
  return grouped;
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

export function AgencyDashboard({ initial, initialLatest }: Props) {
  const [view, setView] = useState<ClientRollupView | null>(initial);
  const [viewMode, setViewMode] = useState<ViewMode>("location");
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | "total">(
    () => initial?.months[initial.months.length - 1]?.monthKey ?? "total"
  );
  const [distributionMetric, setDistributionMetric] = useState<MetricKey>("closed");
  const [ratesMode, setRatesMode] = useState<"simple" | "weighted">("simple");
  const [currentLatest, setCurrentLatest] = useState<ClientAgencySnapshot | null>(
    initialLatest
  );

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
    // when a run is active, also poll the full view every 15s so the dashboard
    // quietly refreshes once it's done even if the user hasn't clicked anything.
    const id = setInterval(reloadSnapshot, 15_000);
    return () => clearInterval(id);
  }, [currentLatest]);

  const locations = useMemo(
    () => (view ? grouping(view.locations, viewMode) : []),
    [view, viewMode]
  );

  const months = view?.months ?? [];
  const latestMonth = months[months.length - 1];
  const prevMonth = months[months.length - 2];

  const kpiCards = useMemo(() => {
    if (!latestMonth) return [];
    return [
      {
        label: "Leads",
        value: formatMetricValue(latestMonth.leads, "count"),
        diff: delta(latestMonth.leads, prevMonth?.leads),
        better: "up" as const,
        kind: "count" as const,
      },
      {
        label: "Appointments",
        value: formatMetricValue(latestMonth.totalAppts, "count"),
        diff: delta(latestMonth.totalAppts, prevMonth?.totalAppts),
        better: "up" as const,
        kind: "count" as const,
      },
      {
        label: "Showed",
        value: formatMetricValue(latestMonth.showed, "count"),
        diff: delta(latestMonth.showed, prevMonth?.showed),
        better: "up" as const,
        kind: "count" as const,
      },
      {
        label: "Closed",
        value: formatMetricValue(latestMonth.closed, "count"),
        diff: delta(latestMonth.closed, prevMonth?.closed),
        better: "up" as const,
        kind: "count" as const,
      },
      {
        label: "Closed value",
        value: formatMetricValue(latestMonth.successValue, "money"),
        diff: delta(latestMonth.successValue, prevMonth?.successValue),
        better: "up" as const,
        kind: "money" as const,
      },
      {
        label: "Ad spend",
        value: formatMetricValue(latestMonth.adSpend, "money"),
        diff: delta(latestMonth.adSpend, prevMonth?.adSpend),
        better: "down" as const,
        kind: "money" as const,
      },
      {
        label: "ROAS",
        value: formatMetricValue(latestMonth.roas, "ratio"),
        diff: delta(latestMonth.roas, prevMonth?.roas),
        better: "up" as const,
        kind: "ratio" as const,
      },
      {
        label: "Clients reporting",
        value: `${latestMonth.clientCount}`,
        sub: `of ${locations.length} total`,
        better: "up" as const,
        kind: "count" as const,
      },
    ];
  }, [latestMonth, prevMonth, locations.length]);

  const latestSnapshotFinished =
    view?.snapshot.finishedAt ?? initial?.snapshot.finishedAt ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">
            Agency rollup
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Performance across every active & 2nd campaign client. Data is
            cached in the database so everyone on the team sees the same
            numbers. Refresh pulls fresh data from GoHighLevel and Meta.
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
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            {kpiCards.map((card, idx) => (
              <Kpi key={idx} {...card} />
            ))}
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
                    title="Average of each client's rate (clients weighted equally)"
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
                    title="Sum across all clients (big accounts dominate)"
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
                Client distribution
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
              Each dot is one client. The indigo bar covers the middle 50% of
              clients; the vertical line is the agency average. Click any dot to
              open that client&apos;s benchmark.
            </p>
            <div className="mt-4">
              <DistributionStrip
                locations={locations}
                metric={distributionMetric}
                monthKey={selectedMonthKey}
                onSelect={(locationId) => {
                  if (locationId.startsWith("cid:")) return;
                  window.location.href = `/agency/dashboard/${locationId}`;
                }}
              />
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Client leaderboard
              </h2>
              <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 p-1 text-xs">
                <button
                  onClick={() => setViewMode("location")}
                  className={`rounded-md px-3 py-1 ${
                    viewMode === "location"
                      ? "bg-indigo-600 text-white"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  By location
                </button>
                <button
                  onClick={() => setViewMode("cid")}
                  className={`rounded-md px-3 py-1 ${
                    viewMode === "cid"
                      ? "bg-indigo-600 text-white"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  By CID (client)
                </button>
              </div>
            </div>
            <LeaderboardTable
              locations={locations}
              monthKey={selectedMonthKey}
            />
          </section>

          <section className="space-y-2 text-xs text-slate-500">
            <div>
              Snapshot #{view.snapshot.id} ·{" "}
              {view.snapshot.clientsIncluded} included ·{" "}
              {view.snapshot.clientsFailed} excluded ·{" "}
              {view.snapshot.monthsCovered} months
            </div>
            {view.snapshot.errors.length > 0 && (
              <details className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
                <summary className="cursor-pointer text-sm text-slate-300">
                  {view.snapshot.errors.length} locations could not be
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
