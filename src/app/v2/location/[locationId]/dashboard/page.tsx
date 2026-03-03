"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { applyRollup } from "@/lib/funnel-metrics";

interface FunnelMetrics {
  leads: number;
  requested: number;
  confirmed: number;
  totalAppts: number;
  totalApptsRaw?: number;
  showed: number;
  noShow: number;
  success: number;
  closed: number;
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

interface MonthlyData {
  monthKey: string;
  startDate: string;
  endDate: string;
  metrics: FunnelMetrics;
}

interface ConversionMetrics extends FunnelMetrics {}

interface PipelineStage {
  id: string;
  name: string;
  position?: number;
}

interface UnmappedStage {
  name: string;
  count: number;
}

interface StageMappingInfo {
  name: string;
  count: number;
  mapping: MappableStage | null;
}

interface ConversionData {
  pipeline: { id: string; name: string; stages?: PipelineStage[] } | null;
  pipelines?: { id: string; name: string }[];
  metrics: ConversionMetrics | null;
  stageCounts?: Record<string, number>;
  dateRange?: { startDate: string; endDate: string };
  unmappedStages?: UnmappedStage[];
  allStageMappings?: StageMappingInfo[];
  message?: string;
}

type FunnelStage = "requested" | "confirmed" | "showed" | "noShow" | "closed";
type MappableStage = FunnelStage | "lead";

interface LocationSettings {
  locationId: string;
  defaultPipelineId: string | null;
  defaultCampaignId: string | null;
  stageMappings: Record<string, Record<string, MappableStage>>;
  adSpend: Record<string, Record<string, number>>;
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
  const [activeTab, setActiveTab] = useState<"funnel" | "monthly">("funnel");
  const [monthlyData, setMonthlyData] = useState<MonthlyData[] | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [rollupAssumptions, setRollupAssumptions] = useState(false);
  const [settings, setSettings] = useState<LocationSettings | null>(null);
  const [unmappedStages, setUnmappedStages] = useState<UnmappedStage[]>([]);
  const [allStageMappings, setAllStageMappings] = useState<StageMappingInfo[]>([]);

  useEffect(() => {
    if (!locationId) return;
    fetch(`/api/location/${locationId}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((s) => (s ? setSettings(s) : null))
      .catch(() => {});
  }, [locationId]);

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
          if (d.pipeline) {
            setSelectedPipelineId(d.pipeline.id);
            setUnmappedStages(d.unmappedStages ?? []);
            setAllStageMappings(d.allStageMappings ?? []);
          }
        }
      })
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  }, [locationId]);

  useEffect(() => {
    if (activeTab !== "monthly" || !locationId || !selectedPipelineId) return;
    const params = new URLSearchParams();
    params.set("pipelineId", selectedPipelineId);
    params.set("months", "13");
    params.set("clientDate", getTodayLocal());
    const apiUrl = `/api/conversions/${locationId}/monthly?${params.toString()}`;
    setMonthlyLoading(true);
    fetch(apiUrl)
      .then((res) => res.json())
      .then((d: { months: MonthlyData[]; unmappedStages?: UnmappedStage[]; allStageMappings?: StageMappingInfo[] }) => {
        setMonthlyData(d.months ?? []);
        if (d.unmappedStages) setUnmappedStages(d.unmappedStages);
        if (d.allStageMappings) setAllStageMappings(d.allStageMappings);
      })
      .catch(() => setMonthlyData([]))
      .finally(() => setMonthlyLoading(false));
  }, [activeTab, locationId, selectedPipelineId]);

  const handlePipelineChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setSelectedPipelineId(id);
    if (!locationId) return;

    if (id) {
      fetch(`/api/location/${locationId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPipelineId: id }),
      })
        .then((res) => res.ok ? res.json() : null)
        .then((s) => s && setSettings((prev) => (prev ? { ...prev, defaultPipelineId: id } : s)))
        .catch(() => {});
    }

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

  const refetchConversions = () => {
    if (!locationId) return;
    const params = new URLSearchParams();
    params.set("dateRange", dateRangePreset);
    params.set("clientDate", getTodayLocal());
    if (selectedPipelineId) params.set("pipelineId", selectedPipelineId);
    if (dateRangePreset === "custom" && customDateFrom && customDateTo) {
      params.set("dateFrom", customDateFrom);
      params.set("dateTo", customDateTo);
    }
    fetch(`/api/conversions/${locationId}?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d: ConversionData | null) => {
        if (d) {
          setData(d);
          if (d.unmappedStages) setUnmappedStages(d.unmappedStages);
          if (d.allStageMappings) setAllStageMappings(d.allStageMappings);
        }
      })
      .catch(() => {});
  };

  const refetchMonthly = () => {
    if (!locationId || !selectedPipelineId || activeTab !== "monthly") return;
    const params = new URLSearchParams();
    params.set("pipelineId", selectedPipelineId);
    params.set("months", "13");
    params.set("clientDate", getTodayLocal());
    fetch(`/api/conversions/${locationId}/monthly?${params.toString()}`)
      .then((res) => res.json())
      .then((d: { months: MonthlyData[]; unmappedStages?: UnmappedStage[]; allStageMappings?: StageMappingInfo[] }) => {
        setMonthlyData(d.months ?? []);
        if (d.unmappedStages) setUnmappedStages(d.unmappedStages);
        if (d.allStageMappings) setAllStageMappings(d.allStageMappings);
      })
      .catch(() => {});
  };

  const handleStageMappingChange = (stageName: string, mapTo: MappableStage | "") => {
    if (!locationId || !data?.pipeline) return;
    const pipelineId = data.pipeline.id;
    fetch(`/api/location/${locationId}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stageMapping: {
          pipelineId,
          stageName,
          mapTo: mapTo || null,
        },
      }),
    })
      .then((res) => res.ok ? res.json() : null)
      .then((s) => {
        if (s) {
          setSettings((prev) =>
            prev
              ? {
                  ...prev,
                  stageMappings: {
                    ...prev.stageMappings,
                    [pipelineId]: {
                      ...(prev.stageMappings[pipelineId] ?? {}),
                      ...(mapTo ? { [stageName]: mapTo } : {}),
                    },
                  },
                }
              : prev
          );
          refetchConversions();
          if (activeTab === "monthly") refetchMonthly();
        }
      })
      .catch(() => {});
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
            {activeTab === "funnel" && (
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
            )}
            {activeTab === "monthly" && (
            <div className="min-w-[160px]">
              <label className="mb-1.5 block text-sm font-medium text-slate-400">
                Campaign
              </label>
              <select
                disabled
                className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-slate-500"
              >
                <option className="bg-slate-900">—</option>
              </select>
            </div>
            )}
            {activeTab === "funnel" && dateRangePreset === "custom" && (
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

        {/* Tabs + Rollup toggle */}
        {!error && (data?.pipelines?.length ?? 0) > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-4">
            <div className="flex gap-2">
            <button
              onClick={() => setActiveTab("funnel")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === "funnel"
                  ? "bg-indigo-600 text-white"
                  : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              Funnel
            </button>
            <button
              onClick={() => setActiveTab("monthly")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === "monthly"
                  ? "bg-indigo-600 text-white"
                  : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              Month to Month
            </button>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={rollupAssumptions}
                onChange={(e) => setRollupAssumptions(e.target.checked)}
                className="rounded border-white/20 bg-white/5"
              />
              <span className="text-sm text-slate-400">Rollup Assumptions</span>
            </label>
          </div>
        )}

        {/* Content */}
        {activeTab === "monthly" ? (
          monthlyLoading ? (
            <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-12 py-24">
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                <p className="text-slate-400">Loading monthly metrics…</p>
              </div>
            </div>
          ) : monthlyData && monthlyData.length > 0 ? (
            <MonthToMonthTable
              months={monthlyData}
              locationId={locationId ?? ""}
              pipelineId={selectedPipelineId}
              rollupAssumptions={rollupAssumptions}
              adSpend={settings?.adSpend?.[selectedPipelineId] ?? {}}
              onAdSpendChange={(monthKey, value) => {
                if (!locationId || !selectedPipelineId) return;
                const next = {
                  ...(settings?.adSpend ?? {}),
                  [selectedPipelineId]: {
                    ...(settings?.adSpend?.[selectedPipelineId] ?? {}),
                    [monthKey]: value,
                  },
                };
                setSettings((prev) => (prev ? { ...prev, adSpend: next } : prev));
                fetch(`/api/location/${locationId}/settings`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ adSpend: next }),
                }).catch(() => {});
              }}
            />
          ) : (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-6">
              <p className="font-medium text-amber-200">No monthly data</p>
              <p className="mt-1 text-amber-200/90">
                Select a pipeline and try again.
              </p>
            </div>
          )
        ) : (
          <>
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
                {(() => {
                  const metrics = rollupAssumptions ? applyRollup(data.metrics) : data.metrics;
                  return (
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
                  {metrics.totalValue > 0 && (
                    <p className="text-xl font-semibold tabular-nums text-indigo-300">
                      ${formatCurrency(metrics.totalValue)} pipeline value
                    </p>
                  )}
                </div>

                {/* Total Appointments accordion - collapsed hides requested/confirmed/showed breakdown */}
                <details className="rounded-xl border border-white/10 bg-white/5">
                  <summary className="cursor-pointer px-5 py-4 text-sm text-slate-400 hover:text-slate-300">
                    Total Appointments <span className="font-medium text-white">({(data.metrics.totalApptsRaw ?? data.metrics.requested + data.metrics.confirmed + data.metrics.showed)})</span>
                  </summary>
                  <div className="border-t border-white/10 px-5 py-4">
                    <div className="flex flex-wrap gap-4 text-sm">
                      <span><span className="text-slate-500">Requested:</span> {data.metrics.requested}</span>
                      <span><span className="text-slate-500">Confirmed:</span> {data.metrics.confirmed}</span>
                      <span><span className="text-slate-500">Showed:</span> {data.metrics.showed}</span>
                    </div>
                  </div>
                </details>

                {/* Funnel metrics - compact grid */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <FunnelMetricCard
                    label="Booking rate"
                    rate={metrics.bookingRate}
                    subtitle={
                      rollupAssumptions ? (
                        <>
                          {metrics.requested} of {metrics.leads} reached appointment
                        </>
                      ) : (
                        <>
                          {metrics.totalAppts} of{" "}
                          {metrics.leads + metrics.totalAppts} booked{" "}
                          <span className="text-slate-500">
                            ({metrics.requested} requested + {metrics.confirmed} confirmed)
                          </span>
                        </>
                      )
                    }
                    value={metrics.requestedValue + metrics.confirmedValue}
                  />
                  <FunnelMetricCard
                    label="Confirmation rate"
                    rate={metrics.confirmationRate}
                    subtitle={
                      <>
                        {metrics.confirmed} confirmed of {metrics.totalAppts} appts
                      </>
                    }
                    value={metrics.confirmedValue}
                  />
                  <FunnelMetricCard
                    label="Show rate"
                    rate={metrics.showRate}
                    subtitle={
                      <>
                        {metrics.showed} showed of {metrics.totalAppts} appts
                      </>
                    }
                    value={metrics.showedValue}
                  />
                  <FunnelMetricCard
                    label="Showed conversions"
                    rate={metrics.showedConversionRate}
                    subtitle={
                      <>
                        {metrics.success} converted of {metrics.showed} showed
                      </>
                    }
                    value={metrics.successValue}
                    accent
                  />
                </div>

                {/* Value breakdown when we have values */}
                {(metrics.showedValue > 0 || metrics.successValue > 0) && (
                  <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-4">
                    <p className="text-sm font-medium text-slate-400">Value by stage</p>
                    <div className="mt-2 flex flex-wrap gap-4">
                      {metrics.showedValue > 0 && (
                        <span className="text-sm">
                          <span className="text-slate-500">Showed:</span>{" "}
                          <span className="font-medium text-white">
                            ${formatCurrency(metrics.showedValue)}
                          </span>
                        </span>
                      )}
                      {metrics.successValue > 0 && (
                        <span className="text-sm">
                          <span className="text-slate-500">Success:</span>{" "}
                          <span className="font-medium text-indigo-300">
                            ${formatCurrency(metrics.successValue)}
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
                  );
                })()}
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
        {debug && !loading && activeTab === "funnel" && (
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
          </>
        )}

        {/* Pipeline Stage Mapping - accordion below data, open + orange when unmapped */}
        {data?.pipeline && allStageMappings.length > 0 && (
          <details
            open={unmappedStages.length > 0}
            className={`mt-8 rounded-xl border px-5 py-4 ${
              unmappedStages.length > 0
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-white/10 bg-white/5"
            }`}
          >
            <summary className="cursor-pointer text-sm font-medium text-slate-300 hover:text-white">
              Pipeline Stage Mapping
              {unmappedStages.length > 0 && (
                <span className="ml-2 text-amber-200">
                  ({unmappedStages.length} unmapped)
                </span>
              )}
            </summary>
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="mb-3 text-xs text-slate-400">
                Map each pipeline stage to a funnel stage. Built-in rules apply first; use dropdowns to override.
              </p>
              <div className="flex flex-wrap gap-3">
                {allStageMappings.map(({ name, count, mapping }) => {
                  const pipelineId = data!.pipeline!.id;
                  const customMapping = settings?.stageMappings?.[pipelineId]?.[name];
                  const displayValue = customMapping ?? "";
                  const isUnmapped = mapping === null;
                  return (
                    <div
                      key={name}
                      className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                        isUnmapped ? "bg-amber-500/10" : "bg-white/5"
                      }`}
                    >
                      <span className="text-sm text-slate-300">
                        {name} <span className="text-slate-500">({count})</span>
                      </span>
                      <select
                        value={displayValue}
                        onChange={(e) => {
                          const v = (e.target.value as MappableStage | "") || "";
                          handleStageMappingChange(name, v);
                        }}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="" className="bg-slate-900">
                          {mapping ? `Use default (${mappingLabel(mapping)})` : "Map to…"}
                        </option>
                        <option value="lead" className="bg-slate-900">Lead</option>
                        <option value="requested" className="bg-slate-900">Requested</option>
                        <option value="confirmed" className="bg-slate-900">Confirmed</option>
                        <option value="showed" className="bg-slate-900">Showed</option>
                        <option value="noShow" className="bg-slate-900">No Show</option>
                        <option value="closed" className="bg-slate-900">Closed / Success</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function mappingLabel(m: string): string {
  const labels: Record<string, string> = {
    lead: "Lead",
    requested: "Requested",
    confirmed: "Confirmed",
    showed: "Showed",
    noShow: "No Show",
    closed: "Closed",
  };
  return labels[m] ?? m;
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

function MonthToMonthTable({
  months,
  locationId,
  pipelineId,
  rollupAssumptions,
  adSpend = {},
  onAdSpendChange,
}: {
  months: MonthlyData[];
  locationId: string;
  pipelineId: string;
  rollupAssumptions: boolean;
  adSpend?: Record<string, number>;
  onAdSpendChange?: (monthKey: string, value: number) => void;
}) {
  const setSpend = (monthKey: string, value: number) => {
    onAdSpendChange?.(monthKey, value);
  };

  const monthLabel = (monthKey: string) => {
    const [y, m] = monthKey.split("-").map(Number);
    return `${m}/${1}/${y}`;
  };

  const getMetrics = (m: MonthlyData) =>
    rollupAssumptions ? applyRollup(m.metrics) : m.metrics;

  const [appointmentsExpanded, setAppointmentsExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <h2 className="px-5 py-4 text-lg font-semibold text-white">
        Month to Month Overview
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-white/10">
              <th className="sticky left-0 z-10 min-w-[180px] bg-slate-900/95 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                Metric
              </th>
              {months.map((m) => (
                <th
                  key={m.monthKey}
                  className="min-w-[90px] px-4 py-3 text-center text-xs font-medium text-slate-400"
                >
                  {monthLabel(m.monthKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            <tr>
              <td className="sticky left-0 z-10 bg-slate-900/95 px-4 py-3 text-sm text-slate-300">
                Total Amount Spent
              </td>
              {months.map((m) => (
                <td key={m.monthKey} className="px-4 py-2 text-center">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={adSpend[m.monthKey] ?? ""}
                    onChange={(e) => setSpend(m.monthKey, parseFloat(e.target.value) || 0)}
                    onBlur={(e) => setSpend(m.monthKey, parseFloat((e.target as HTMLInputElement).value) || 0)}
                    placeholder="0"
                    className="w-20 rounded border border-white/20 bg-white/5 px-2 py-1 text-center text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </td>
              ))}
            </tr>
            <MetricRow label="Total Leads" values={months.map((m) => getMetrics(m).leads)} />
            <MetricRow
              label="Total CPL"
              values={months.map((m) => {
                const spend = adSpend[m.monthKey] ?? 0;
                const leads = getMetrics(m).leads;
                return leads > 0 && spend > 0 ? spend / leads : null;
              })}
              format="currency"
            />
            <MetricRow
              label="Booking %"
              values={months.map((m) => getMetrics(m).bookingRate)}
              format="percent"
            />
            <TotalAppointmentsRow
              months={months}
              expanded={appointmentsExpanded}
              onToggle={() => setAppointmentsExpanded((e) => !e)}
            />
            {appointmentsExpanded && (
              <>
                <MetricRow
                  label="Total Appt Requested"
                  values={months.map((m) => getMetrics(m).requested)}
                />
                <MetricRow
                  label="Total Appt Confirmed"
                  values={months.map((m) => getMetrics(m).confirmed)}
                />
                <MetricRow label="Total Show" values={months.map((m) => getMetrics(m).showed)} />
              </>
            )}
            <MetricRow
              label="Show %"
              values={months.map((m) => getMetrics(m).showRate)}
              format="percent"
            />
            <MetricRow label="Total No Show" values={months.map((m) => getMetrics(m).noShow)} />
            <MetricRow label="Total Closed" values={months.map((m) => getMetrics(m).closed)} />
            <MetricRow
              label="Total CPS"
              values={months.map((m) => {
                const spend = adSpend[m.monthKey] ?? 0;
                const closed = m.metrics.closed;
                return closed > 0 && spend > 0 ? spend / closed : null;
              })}
              format="currency"
            />
            <MetricRow
              label="Total CPC"
              values={months.map((m) => {
                const spend = adSpend[m.monthKey] ?? 0;
                const confirmed = m.metrics.confirmed;
                return confirmed > 0 && spend > 0 ? spend / confirmed : null;
              })}
              format="currency"
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TotalAppointmentsRow({
  months,
  expanded,
  onToggle,
}: {
  months: MonthlyData[];
  expanded?: boolean;
  onToggle?: () => void;
}) {
  // Always use raw counts (requested + confirmed + showed) - not rolled up
  const values = months.map((m) => {
    const { requested, confirmed, showed } = m.metrics;
    return (m.metrics.totalApptsRaw ?? requested + confirmed + showed);
  });
  return (
    <tr>
      <td className="sticky left-0 z-10 bg-slate-900/95 px-4 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 text-left text-sm text-slate-300 hover:text-white"
        >
          <span className="tabular-nums">{expanded ? "▼" : "▶"}</span>
          Total Appointments
        </button>
      </td>
      {values.map((v, i) => (
        <td key={i} className="px-4 py-2 text-center text-sm tabular-nums text-white">
          {v}
        </td>
      ))}
    </tr>
  );
}

function MetricRow({
  label,
  values,
  format = "number",
}: {
  label: string;
  values: (number | null)[];
  format?: "number" | "percent" | "currency";
}) {
  const fmt = (v: number | null) => {
    if (v == null) return "—";
    if (format === "percent") return `${v}%`;
    if (format === "currency") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return String(v);
  };
  return (
    <tr>
      <td className="sticky left-0 z-10 bg-slate-900/95 px-4 py-2 text-sm text-slate-300">
        {label}
      </td>
      {values.map((v, i) => (
        <td key={i} className="px-4 py-2 text-center text-sm tabular-nums text-white">
          {fmt(v)}
        </td>
      ))}
    </tr>
  );
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

