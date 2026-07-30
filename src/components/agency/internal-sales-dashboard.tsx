"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";
import type {
  InternalSalesMetrics,
  InternalSalesMonthRow,
} from "@/lib/internal-sales-metrics";
import { countDelta, rateDelta } from "@/lib/internal-sales-metrics";

type Tab = "funnel" | "monthly";

interface FunnelResponse {
  view: "funnel";
  range: {
    preset: DateRangePreset;
    startDate: string;
    endDate: string;
    label: string;
  };
  previousRange: { startDate: string; endDate: string } | null;
  metrics: InternalSalesMetrics;
  previousMetrics: InternalSalesMetrics | null;
  rowCount: number;
  fetchedAt: number;
  fromCache: boolean;
  warning?: string;
  error?: string;
}

interface MonthlyResponse {
  view: "monthly";
  months: InternalSalesMonthRow[];
  rowCount: number;
  fetchedAt: number;
  fromCache: boolean;
  warning?: string;
  error?: string;
}

const DATE_RANGE_ORDER: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_7",
  "last_14",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

function formatPct(v: number | null): string {
  if (v == null) return "—";
  return `${v}%`;
}

function formatDeltaPct(v: number | null): string | null {
  if (v == null) return null;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v}pp`;
}

function formatDeltaCount(v: number): string | null {
  if (v === 0) return "0";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v}`;
}

function DeltaBadge({
  value,
  kind,
}: {
  value: number | null;
  kind: "pct" | "count";
}) {
  if (value == null) return null;
  const label =
    kind === "pct" ? formatDeltaPct(value) : formatDeltaCount(value);
  if (!label) return null;
  const positive = value > 0;
  const negative = value < 0;
  return (
    <span
      className={`text-xs ${
        positive
          ? "text-emerald-400"
          : negative
            ? "text-rose-400"
            : "text-slate-500"
      }`}
    >
      {label}
    </span>
  );
}

function KpiCard({
  label,
  value,
  delta,
  deltaKind = "count",
  sub,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaKind?: "pct" | "count";
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-2xl font-semibold tabular-nums text-white">{value}</p>
        {delta !== undefined && (
          <DeltaBadge value={delta} kind={deltaKind} />
        )}
      </div>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

function FunnelBar({
  label,
  count,
  max,
  rate,
}: {
  label: string;
  count: number;
  max: number;
  rate?: number | null;
}) {
  const width = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="tabular-nums text-slate-400">
          <span className="font-medium text-white">{count}</span>
          {rate != null ? (
            <span className="ml-2 text-xs text-slate-500">{formatPct(rate)}</span>
          ) : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-indigo-500 transition-[width] duration-300"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function InternalSalesDashboard() {
  const [tab, setTab] = useState<Tab>("funnel");
  const [preset, setPreset] = useState<DateRangePreset>("last_30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [monthly, setMonthly] = useState<MonthlyResponse | null>(null);

  const fetchFunnel = useCallback(
    async (
      nextPreset: DateRangePreset,
      from?: string,
      to?: string,
      nextCompare?: boolean
    ) => {
      if (nextPreset === "custom" && (!from || !to)) return;
      const params = new URLSearchParams();
      params.set("view", "funnel");
      params.set("preset", nextPreset);
      params.set("clientDate", getTodayLocal());
      if (nextCompare) params.set("compare", "true");
      if (nextPreset === "custom" && from && to) {
        params.set("dateFrom", from);
        params.set("dateTo", to);
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/agency/internal-sales?${params.toString()}`,
          { cache: "no-store" }
        );
        const body = (await res.json()) as FunnelResponse;
        if (!res.ok) {
          setError(body.error || "Failed to load");
          return;
        }
        setFunnel(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const fetchMonthly = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("view", "monthly");
    params.set("months", "13");
    params.set("clientDate", getTodayLocal());
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agency/internal-sales?${params.toString()}`,
        { cache: "no-store" }
      );
      const body = (await res.json()) as MonthlyResponse;
      if (!res.ok) {
        setError(body.error || "Failed to load");
        return;
      }
      setMonthly(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFunnel("last_30", undefined, undefined, false);
  }, [fetchFunnel]);

  const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as DateRangePreset;
    setPreset(next);
    if (next === "custom") return;
    void fetchFunnel(next, customFrom, customTo, compare);
  };

  const handleCustomApply = () => {
    if (!customFrom || !customTo) return;
    void fetchFunnel("custom", customFrom, customTo, compare);
  };

  const handleCompareToggle = (checked: boolean) => {
    setCompare(checked);
    void fetchFunnel(preset, customFrom, customTo, checked);
  };

  const handleTabChange = (next: Tab) => {
    setTab(next);
    if (next === "monthly") {
      if (!monthly) void fetchMonthly();
    } else if (!funnel) {
      void fetchFunnel(preset, customFrom, customTo, compare);
    }
  };

  const m = funnel?.metrics;
  const prev = funnel?.previousMetrics;
  const c = m?.counts;
  const r = m?.rates;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 text-white">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/agency"
            className="text-sm text-slate-400 transition hover:text-white"
          >
            ← Launcher
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            Internal Sales
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Appointments sheet · booking, show, and close rates
          </p>
        </div>

        {tab === "funnel" ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-xs text-slate-400">
              Date range
              <select
                value={preset}
                onChange={handlePresetChange}
                className="mt-1 block rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {DATE_RANGE_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {p === "maximum" ? "All time" : DATE_RANGE_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            {preset === "custom" ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="block text-xs text-slate-400">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="mt-1 block rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                </label>
                <label className="block text-xs text-slate-400">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="mt-1 block rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleCustomApply}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Apply
                </button>
              </div>
            ) : null}
            <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => handleCompareToggle(e.target.checked)}
                className="rounded border-white/20 bg-slate-900"
              />
              Compare prior period
            </label>
          </div>
        ) : null}
      </header>

      <div className="mt-6 flex gap-1 rounded-lg bg-slate-800/50 p-1 w-fit">
        {(
          [
            { id: "funnel" as const, label: "Funnel" },
            { id: "monthly" as const, label: "Month to Month" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => handleTabChange(t.id)}
            className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
              tab === t.id
                ? "bg-indigo-600 text-white"
                : "text-slate-300 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {funnel?.warning || monthly?.warning ? (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {funnel?.warning || monthly?.warning}
        </div>
      ) : null}

      {loading && !funnel && !monthly ? (
        <p className="mt-10 text-sm text-slate-500">Loading…</p>
      ) : null}

      {tab === "funnel" && m && c && r ? (
        <div className={`mt-8 space-y-8 ${loading ? "opacity-60" : ""}`}>
          {funnel?.range ? (
            <p className="text-xs text-slate-500">
              {funnel.range.label} · {funnel.range.startDate} →{" "}
              {funnel.range.endDate}
              {compare && funnel.previousRange
                ? ` · vs ${funnel.previousRange.startDate} → ${funnel.previousRange.endDate}`
                : null}
              {funnel.rowCount
                ? ` · ${funnel.rowCount} rows in sheet`
                : null}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Leads"
              value={String(c.leads)}
              delta={
                compare && prev
                  ? countDelta(c.leads, prev.counts.leads)
                  : undefined
              }
            />
            <KpiCard
              label="Booked"
              value={String(c.booked)}
              delta={
                compare && prev
                  ? countDelta(c.booked, prev.counts.booked)
                  : undefined
              }
            />
            <KpiCard
              label="Booking rate"
              value={formatPct(r.bookingRate)}
              delta={
                compare && prev
                  ? rateDelta(r.bookingRate, prev.rates.bookingRate)
                  : undefined
              }
              deltaKind="pct"
            />
            <KpiCard
              label="Qualified rate"
              value={formatPct(r.qualifiedRate)}
              delta={
                compare && prev
                  ? rateDelta(r.qualifiedRate, prev.rates.qualifiedRate)
                  : undefined
              }
              deltaKind="pct"
              sub={`${c.qualifiedYes} yes · ${c.qualifiedNo} no`}
            />
            <KpiCard
              label="Showed"
              value={String(c.showed)}
              delta={
                compare && prev
                  ? countDelta(c.showed, prev.counts.showed)
                  : undefined
              }
            />
            <KpiCard
              label="Show rate"
              value={formatPct(r.showRate)}
              delta={
                compare && prev
                  ? rateDelta(r.showRate, prev.rates.showRate)
                  : undefined
              }
              deltaKind="pct"
              sub={`${c.noShowed} no-shows`}
            />
            <KpiCard
              label="Signed"
              value={String(c.signed)}
              delta={
                compare && prev
                  ? countDelta(c.signed, prev.counts.signed)
                  : undefined
              }
            />
            <KpiCard
              label="Close rate"
              value={formatPct(r.closeRate)}
              delta={
                compare && prev
                  ? rateDelta(r.closeRate, prev.rates.closeRate)
                  : undefined
              }
              deltaKind="pct"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiCard label="Cancelled" value={String(c.cancelled)} />
            <KpiCard label="No showed" value={String(c.noShowed)} />
            <KpiCard label="Rescheduled" value={String(c.rescheduled)} />
            <KpiCard
              label="Pipeline"
              value={String(c.pipeline)}
              sub="Good / great / some chance"
            />
            <KpiCard label="No chance" value={String(c.noChance)} />
          </div>

          <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-5">
            <h2 className="text-sm font-semibold text-white">Funnel</h2>
            <p className="mt-1 text-xs text-slate-500">
              Leads → booked → showed → signed
            </p>
            <div className="mt-5 space-y-4">
              <FunnelBar label="Leads" count={c.leads} max={c.leads} />
              <FunnelBar
                label="Booked"
                count={c.booked}
                max={c.leads}
                rate={r.bookingRate}
              />
              <FunnelBar
                label="Showed"
                count={c.showed}
                max={c.leads}
                rate={r.showRate}
              />
              <FunnelBar
                label="Signed"
                count={c.signed}
                max={c.leads}
                rate={r.closeRate}
              />
            </div>
          </section>
        </div>
      ) : null}

      {tab === "monthly" && monthly ? (
        <div className={`mt-8 ${loading ? "opacity-60" : ""}`}>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <div className="px-5 py-4">
              <h2 className="text-lg font-semibold text-white">
                Month to Month Overview
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Last {monthly.months.length} calendar months
              </p>
            </div>
            <div className="overflow-x-auto pb-5">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="sticky left-0 z-10 min-w-[160px] bg-slate-900/95 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                      Metric
                    </th>
                    {monthly.months.map((m) => {
                      const [y, mo] = m.monthKey.split("-").map(Number);
                      return (
                        <th
                          key={m.monthKey}
                          className="min-w-[90px] px-4 py-3 text-center text-xs font-medium text-slate-400"
                        >
                          {`${mo}/1/${y}`}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <SalesMetricRow
                    label="Leads"
                    values={monthly.months.map((m) => m.metrics.counts.leads)}
                  />
                  <SalesMetricRow
                    label="Booking %"
                    values={monthly.months.map(
                      (m) => m.metrics.rates.bookingRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Appointments"
                    values={monthly.months.map((m) => m.metrics.counts.booked)}
                  />
                  <SalesMetricRow
                    label="Showed"
                    values={monthly.months.map((m) => m.metrics.counts.showed)}
                  />
                  <SalesMetricRow
                    label="No Show"
                    values={monthly.months.map(
                      (m) => m.metrics.counts.noShowed
                    )}
                  />
                  <SalesMetricRow
                    label="Cancelled"
                    values={monthly.months.map(
                      (m) => m.metrics.counts.cancelled
                    )}
                  />
                  <SalesMetricRow
                    label="Show %"
                    values={monthly.months.map((m) => m.metrics.rates.showRate)}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Signed"
                    values={monthly.months.map((m) => m.metrics.counts.signed)}
                  />
                  <SalesMetricRow
                    label="Close %"
                    values={monthly.months.map(
                      (m) => m.metrics.rates.closeRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Qualified %"
                    values={monthly.months.map(
                      (m) => m.metrics.rates.qualifiedRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Pipeline"
                    values={monthly.months.map(
                      (m) => m.metrics.counts.pipeline
                    )}
                  />
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SalesMetricRow({
  label,
  values,
  format = "number",
}: {
  label: string;
  values: (number | null)[];
  format?: "number" | "percent";
}) {
  const fmt = (v: number | null) => {
    if (v == null) return "—";
    if (format === "percent") return `${v}%`;
    return String(v);
  };
  return (
    <tr>
      <td className="sticky left-0 z-10 bg-slate-900/95 px-4 py-2 text-sm text-slate-300">
        {label}
      </td>
      {values.map((v, i) => (
        <td
          key={i}
          className="px-4 py-2 text-center text-sm tabular-nums text-white"
        >
          {fmt(v)}
        </td>
      ))}
    </tr>
  );
}
