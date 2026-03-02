"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";

interface FunnelMetrics {
  leads: number;
  requested: number;
  confirmed: number;
  totalAppts: number;
  showed: number;
  success: number;
  total: number;
  bookingRate: number | null;
  confirmationRate: number | null;
  showRate: number | null;
  showedConversionRate: number | null;
  totalValue: number;
  showedValue: number;
  successValue: number;
  requestedValue: number;
  confirmedValue: number;
}

interface ConversionMetrics extends FunnelMetrics {}

interface PipelineStage {
  id: string;
  name: string;
  position?: number;
}

interface ConversionData {
  pipeline: { id: string; name: string; stages?: PipelineStage[] } | null;
  pipelines?: { id: string; name: string }[];
  metrics: ConversionMetrics | null;
  stageCounts?: Record<string, number>;
  dateRange?: { startDate: string; endDate: string };
  message?: string;
}

export default function ConversionsDashboard() {
  const params = useParams();
  const searchParams = useSearchParams();
  const locationId = params?.locationId as string | undefined;
  const connectSource = searchParams?.get("source");
  const connectCount = searchParams?.get("count");
  const [data, setData] = useState<ConversionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<{ url: string; status?: number; body?: string } | null>(null);

  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>("last_30");
  const [customDateFrom, setCustomDateFrom] = useState("");
  const [customDateTo, setCustomDateTo] = useState("");

  useEffect(() => {
    if (!locationId) {
      setLoading(false);
      return;
    }

    const params = new URLSearchParams();
    params.set("dateRange", "last_30");
    params.set("clientDate", getTodayLocal());
    const apiUrl = `/api/conversions/${locationId}?${params.toString()}`;
    setLoading(true);
    setError(null);
    setDebug({ url: apiUrl });

    fetch(apiUrl)
      .then(async (res) => {
        const body = await res.text();
        setDebug((d) => ({ ...d!, status: res.status, body: body.slice(0, 500) }));
        if (res.status === 401) {
          const parsed = JSON.parse(body || "{}");
          if (parsed.needsAuth) {
            setError("NEEDS_AUTH");
            setData(null);
            return;
          }
        }
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
        }
        return JSON.parse(body);
      })
      .then((d: ConversionData) => {
        if (d !== undefined) {
          setData(d);
          if (d.pipeline) setSelectedPipelineId(d.pipeline.id);
        }
      })
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  }, [locationId]);

  const handlePipelineChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setSelectedPipelineId(id);
    if (!locationId) return;

    const params = new URLSearchParams();
    params.set("dateRange", dateRangePreset);
    params.set("clientDate", getTodayLocal());
    if (id) params.set("pipelineId", id);
    if (dateRangePreset === "custom" && customDateFrom && customDateTo) {
      params.set("dateFrom", customDateFrom);
      params.set("dateTo", customDateTo);
    }

    const apiUrl = `/api/conversions/${locationId}?${params.toString()}`;
    setLoading(true);
    fetch(apiUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((d: ConversionData) => setData(d))
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  };

  const handleDateRangeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const preset = e.target.value as DateRangePreset;
    setDateRangePreset(preset);
    if (!locationId || preset === "custom") return; // Custom waits for Apply

    const urlParams = new URLSearchParams();
    urlParams.set("dateRange", preset);
    urlParams.set("clientDate", getTodayLocal());
    if (selectedPipelineId) urlParams.set("pipelineId", selectedPipelineId);

    const apiUrl = `/api/conversions/${locationId}?${urlParams.toString()}`;
    setLoading(true);
    fetch(apiUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((d: ConversionData) => setData(d))
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  };

  const handleCustomDateApply = () => {
    if (!locationId || !customDateFrom || !customDateTo) return;
    const params = new URLSearchParams();
    params.set("dateRange", "custom");
    params.set("dateFrom", customDateFrom);
    params.set("dateTo", customDateTo);
    params.set("clientDate", getTodayLocal());
    if (selectedPipelineId) params.set("pipelineId", selectedPipelineId);

    const apiUrl = `/api/conversions/${locationId}?${params.toString()}`;
    setLoading(true);
    fetch(apiUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((d: ConversionData) => setData(d))
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  };

  if (!locationId) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* Header */}
        <header className="mb-12">
          <h1 className="font-display text-4xl font-bold tracking-tight text-white/95 md:text-5xl">
            Conversions Dashboard
          </h1>
          <p className="mt-2 text-lg text-slate-400">
            Location:{" "}
            <code className="rounded bg-white/10 px-2 py-0.5 font-mono text-sm">
              {locationId}
            </code>
          </p>
          {connectSource && connectCount && (
            <p className="mt-1 text-sm text-slate-500">
              Connected: {connectCount} locations from {connectSource}
            </p>
          )}
        </header>

        {/* Filters - pipeline & date range */}
        {!error && (data?.pipelines?.length ?? 0) > 0 && (
          <div className="mb-8 flex flex-wrap items-end gap-4">
            <div className="min-w-[200px]">
              <label className="mb-1.5 block text-sm font-medium text-slate-400">
                Pipeline
              </label>
              <select
                value={selectedPipelineId}
                onChange={handlePipelineChange}
                disabled={loading}
                className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {!selectedPipelineId && (
                  <option value="" className="bg-slate-900 text-white">
                    Select a pipeline…
                  </option>
                )}
                {data?.pipelines?.map((p) => (
                  <option key={p.id} value={p.id} className="bg-slate-900 text-white">
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[180px]">
              <label className="mb-1.5 block text-sm font-medium text-slate-400">
                Date range
              </label>
              <select
                value={dateRangePreset}
                onChange={handleDateRangeChange}
                disabled={loading}
                className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {(Object.entries(DATE_RANGE_LABELS) as [DateRangePreset, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value} className="bg-slate-900 text-white">
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>
            {dateRangePreset === "custom" && (
              <div className="flex items-end gap-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-400">
                    From
                  </label>
                  <input
                    type="date"
                    value={customDateFrom}
                    onChange={(e) => setCustomDateFrom(e.target.value)}
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-400">
                    To
                  </label>
                  <input
                    type="date"
                    value={customDateTo}
                    onChange={(e) => setCustomDateTo(e.target.value)}
                    className="rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <button
                  onClick={handleCustomDateApply}
                  disabled={loading || !customDateFrom || !customDateTo}
                  className="rounded-xl bg-indigo-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content */}
        {loading && (
          <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-12 py-24">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              <p className="text-slate-400">Loading pipeline metrics…</p>
            </div>
          </div>
        )}

        {error && error !== "NEEDS_AUTH" && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-8 py-6">
            <p className="font-medium text-red-300">Error</p>
            <p className="mt-1 text-red-200/90">{error}</p>
          </div>
        )}

        {error === "NEEDS_AUTH" && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-10">
            <p className="text-lg font-medium text-amber-200">
              Connect to GoHighLevel
            </p>
            <p className="mt-2 text-amber-200/90">
              Authorize this app to read pipeline and opportunity data for this location.
            </p>
            <a
              href={`/api/auth/ghl/authorize?locationId=${encodeURIComponent(locationId)}`}
              target="_top"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Connect with GoHighLevel →
            </a>
          </div>
        )}

        {!loading && !error && !data && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-6">
            <p className="font-medium text-amber-200">No data received</p>
            <p className="mt-1 text-amber-200/90">
              The API request completed but returned nothing. Check the debug info below.
            </p>
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-8">
            {data.pipeline && data.metrics ? (
              <>
                {/* Compact header */}
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-5 py-4">
                  <div>
                    <p className="text-sm text-slate-400">{data.pipeline.name}</p>
                    {data.dateRange && (
                      <p className="text-xs text-slate-500">
                        {formatDate(data.dateRange.startDate)} – {formatDate(data.dateRange.endDate)}
                      </p>
                    )}
                  </div>
                  {data.metrics.totalValue > 0 && (
                    <p className="text-xl font-semibold tabular-nums text-indigo-300">
                      ${formatCurrency(data.metrics.totalValue)} pipeline value
                    </p>
                  )}
                </div>

                {/* Funnel metrics - compact grid */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <FunnelMetricCard
                    label="Booking rate"
                    rate={data.metrics.bookingRate}
                    subtitle={
                      <>
                        {data.metrics.totalAppts} of{" "}
                        {data.metrics.leads + data.metrics.totalAppts} booked{" "}
                        <span className="text-slate-500">
                          ({data.metrics.requested} requested + {data.metrics.confirmed} confirmed)
                        </span>
                      </>
                    }
                    value={data.metrics.requestedValue + data.metrics.confirmedValue}
                  />
                  <FunnelMetricCard
                    label="Confirmation rate"
                    rate={data.metrics.confirmationRate}
                    subtitle={
                      <>
                        {data.metrics.confirmed} confirmed of {data.metrics.totalAppts} appts
                      </>
                    }
                    value={data.metrics.confirmedValue}
                  />
                  <FunnelMetricCard
                    label="Show rate"
                    rate={data.metrics.showRate}
                    subtitle={
                      <>
                        {data.metrics.showed} showed of {data.metrics.totalAppts} appts
                      </>
                    }
                    value={data.metrics.showedValue}
                  />
                  <FunnelMetricCard
                    label="Showed conversions"
                    rate={data.metrics.showedConversionRate}
                    subtitle={
                      <>
                        {data.metrics.success} converted of {data.metrics.showed} showed
                      </>
                    }
                    value={data.metrics.successValue}
                    accent
                  />
                </div>

                {/* Value breakdown when we have values */}
                {(data.metrics.showedValue > 0 || data.metrics.successValue > 0) && (
                  <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-4">
                    <p className="text-sm font-medium text-slate-400">Value by stage</p>
                    <div className="mt-2 flex flex-wrap gap-4">
                      {data.metrics.showedValue > 0 && (
                        <span className="text-sm">
                          <span className="text-slate-500">Showed:</span>{" "}
                          <span className="font-medium text-white">
                            ${formatCurrency(data.metrics.showedValue)}
                          </span>
                        </span>
                      )}
                      {data.metrics.successValue > 0 && (
                        <span className="text-sm">
                          <span className="text-slate-500">Success:</span>{" "}
                          <span className="font-medium text-indigo-300">
                            ${formatCurrency(data.metrics.successValue)}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* All pipeline stages with counts (for debugging) */}
                {((data.pipeline?.stages?.length ?? 0) > 0 ||
                  (data.stageCounts && Object.keys(data.stageCounts).length > 0)) && (
                  <details className="rounded-xl border border-white/10 bg-white/5">
                    <summary className="cursor-pointer px-5 py-4 text-sm text-slate-400 hover:text-slate-300">
                      All stage counts
                    </summary>
                    <div className="border-t border-white/10 px-5 py-4">
                      <div className="flex flex-wrap gap-3">
                        {(data.pipeline?.stages?.length ?? 0) > 0
                          ? [...(data.pipeline!.stages ?? [])]
                              .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                              .map((stage) => {
                                const count = data.stageCounts?.[stage.name] ?? 0;
                                const hasMatch = stage.name in (data.stageCounts ?? {});
                                return (
                                  <span
                                    key={stage.id}
                                    className={`rounded-lg px-3 py-1.5 text-sm ${
                                      hasMatch
                                        ? "bg-white/10"
                                        : "bg-white/5 text-slate-500"
                                    }`}
                                  >
                                    <span className="text-slate-400">{stage.name}:</span>{" "}
                                    <span className="font-medium">{count}</span>
                                  </span>
                                );
                              })
                          : Object.entries(data.stageCounts ?? {}).map(([stage, count]) => (
                              <span
                                key={stage}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm"
                              >
                                <span className="text-slate-400">{stage}:</span>{" "}
                                <span className="font-medium">{count}</span>
                              </span>
                            ))}
                      </div>
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-6">
                <p className="font-medium text-amber-200">
                  No matching pipeline found
                </p>
                <p className="mt-1 text-amber-200/90">
                  {data.message ??
                    "Create a pipeline with 'Pain' in the name (e.g. Pain Patients) to see metrics here."}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Debug panel - always visible when we have debug info */}
        {debug && !loading && (
          <details className="mt-12 rounded-2xl border border-white/10 bg-black/20">
            <summary className="cursor-pointer px-6 py-4 text-sm font-medium text-slate-400 hover:text-slate-300">
              🔧 Debug info
            </summary>
            <div className="border-t border-white/10 px-6 py-4 font-mono text-xs text-slate-500">
              <p><strong>URL:</strong> {debug.url}</p>
              {debug.status != null && <p><strong>Status:</strong> {debug.status}</p>}
              {debug.body && (
                <p className="mt-2 break-all"><strong>Response:</strong> {debug.body}</p>
              )}
              <p className="mt-4 text-slate-600">
                To test the API directly, open: <br />
                <a
                  href={debug.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 underline"
                >
                  {typeof window !== "undefined" ? window.location.origin + debug.url : debug.url}
                </a>
              </p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** Parse YYYY-MM-DD as local date (avoid UTC midnight shifting dates) */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCurrency(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n).toLocaleString();
}

function FunnelMetricCard({
  label,
  rate,
  subtitle,
  value,
  accent,
}: {
  label: string;
  rate: number | null;
  subtitle: React.ReactNode;
  value?: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 backdrop-blur-sm ${
        accent ? "border-indigo-500/50 bg-indigo-500/10" : "border-white/10 bg-white/5"
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${
          accent ? "text-indigo-300" : "text-white"
        }`}
      >
        {rate != null ? `${rate}%` : "—"}
      </p>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      {value !== undefined && value > 0 && (
        <p className="mt-1 text-sm font-medium text-slate-400">
          ${formatCurrency(value)} value
        </p>
      )}
    </div>
  );
}

