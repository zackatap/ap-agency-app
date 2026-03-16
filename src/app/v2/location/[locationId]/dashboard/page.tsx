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
  previousMetrics?: ConversionMetrics | null;
  previousDateRange?: { startDate: string; endDate: string } | null;
  stageCounts?: Record<string, number>;
  leadsBreakdown?: Record<string, number>;
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
  facebookAdAccountId?: string | null;
  facebookCampaignKeyword?: string | null;
  stageMappings: Record<string, Record<string, MappableStage>>;
  adSpend: Record<string, Record<string, number>>;
  rollupAssumptions?: boolean;
  attributionMode?: "created" | "lastUpdated";
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
  const [rollupAssumptions, setRollupAssumptions] = useState(true); // "On Totals" default
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [attributionMode, setAttributionMode] = useState<"created" | "lastUpdated">("lastUpdated");
  const [settings, setSettings] = useState<LocationSettings | null>(null);
  const [unmappedStages, setUnmappedStages] = useState<UnmappedStage[]>([]);
  const [allStageMappings, setAllStageMappings] = useState<StageMappingInfo[]>([]);
  const [campaignKeyword, setCampaignKeyword] = useState("");
  const [sheetCampaignOptions, setSheetCampaignOptions] = useState<string[]>([]);
  const [sheetConfigLoaded, setSheetConfigLoaded] = useState(false);
  const [sheetLookupDebug, setSheetLookupDebug] = useState<{
    searchedFor: string;
    sheetRowCount: number;
    matchedRowCount: number;
    allLocationIdsFromSheet: string[];
    headerRow?: string[];
    locationIdColumnIndex?: number;
    locationIdColumnLetter?: string;
    reason?: string;
  } | null>(null);
  const [facebookAdSpend, setFacebookAdSpend] = useState<Record<string, number>>({});
  const [facebookAdSpendLoading, setFacebookAdSpendLoading] = useState(false);

  useEffect(() => {
    if (!locationId) return;
    fetch(`/api/location/${locationId}/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((s) => {
        if (s) {
          setSettings(s);
          setCampaignKeyword(s.facebookCampaignKeyword ?? "");
          if (s.rollupAssumptions !== undefined) setRollupAssumptions(s.rollupAssumptions);
          if (s.attributionMode !== undefined) setAttributionMode(s.attributionMode);
        }
      })
      .catch(() => {});
  }, [locationId]);

  // Fetch Ad Account ID & Campaign options from Google Sheet
  useEffect(() => {
    if (!locationId) return;
    setSheetConfigLoaded(false);
    setSheetLookupDebug(null);
    fetch(`/api/location/${locationId}/facebook-config`)
      .then((res) => res.json())
      .then((d: {
        config?: { adAccountId: string; campaignKeywords: string[] } | null;
        debug?: { searchedFor: string; sheetRowCount: number; matchedRowCount: number; allLocationIdsFromSheet: string[]; headerRow?: string[]; locationIdColumnIndex?: number; locationIdColumnLetter?: string; reason?: string };
        error?: string;
      }) => {
        const config = d.config;
        if (d.debug) setSheetLookupDebug(d.debug);
        if (config?.adAccountId) {
          setSettings((prev) => (prev ? { ...prev, facebookAdAccountId: config.adAccountId } : prev));
          setSheetCampaignOptions(config.campaignKeywords ?? []);
          fetch(`/api/location/${locationId}/settings`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ facebookAdAccountId: config.adAccountId }),
          }).catch(() => {});
        } else {
          setSheetCampaignOptions([]);
        }
      })
      .catch((err) => {
        setSheetCampaignOptions([]);
        setSheetLookupDebug({
          searchedFor: locationId,
          sheetRowCount: 0,
          matchedRowCount: 0,
          allLocationIdsFromSheet: [],
          reason: err?.message ?? "Request failed",
        });
      })
      .finally(() => setSheetConfigLoaded(true));
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
    params.set("attribution", attributionMode);
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
  }, [activeTab, locationId, selectedPipelineId, attributionMode]);

  // Fetch Facebook ad spend when on monthly tab with ad account + keyword + monthly data
  useEffect(() => {
    const adAccountId = settings?.facebookAdAccountId?.trim();
    if (
      !locationId ||
      !adAccountId ||
      !monthlyData?.length ||
      activeTab !== "monthly"
    ) {
      if (!adAccountId) setFacebookAdSpend({});
      return;
    }
    setFacebookAdSpendLoading(true);
    const monthKeys = monthlyData.map((m) => m.monthKey);
    const params = new URLSearchParams({
      monthKeys: monthKeys.join(","),
    });
    const kw = campaignKeyword.trim();
    if (kw) params.set("campaignKeyword", kw);
    fetch(`/api/location/${locationId}/facebook/insights?${params}`)
      .then((res) => res.json())
      .then((d: { spendByMonth?: Record<string, number>; error?: string }) => {
        setFacebookAdSpend(d.spendByMonth ?? {});
      })
      .catch(() => setFacebookAdSpend({}))
      .finally(() => setFacebookAdSpendLoading(false));
  }, [
    locationId,
    settings?.facebookAdAccountId,
    monthlyData,
    campaignKeyword,
    activeTab,
  ]);

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
    if (compareEnabled) params.set("compare", "true");

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
    if (compareEnabled) urlParams.set("compare", "true");

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
    if (compareEnabled) params.set("compare", "true");
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
    params.set("attribution", attributionMode);
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
    if (compareEnabled) params.set("compare", "true");

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
            <>
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
            <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5">
              <input
                type="checkbox"
                checked={compareEnabled}
                onChange={(e) => {
                  const v = e.target.checked;
                  setCompareEnabled(v);
                  if (locationId) {
                    const params = new URLSearchParams();
                    params.set("dateRange", dateRangePreset);
                    params.set("clientDate", getTodayLocal());
                    if (selectedPipelineId) params.set("pipelineId", selectedPipelineId);
                    if (dateRangePreset === "custom" && customDateFrom && customDateTo) {
                      params.set("dateFrom", customDateFrom);
                      params.set("dateTo", customDateTo);
                    }
                    if (v) params.set("compare", "true");
                    setLoading(true);
                    fetch(`/api/conversions/${locationId}?${params.toString()}`)
                      .then((res) => (res.ok ? res.json() : null))
                      .then((d: ConversionData | null) => {
                        if (d) {
                          setData(d);
                          if (d.unmappedStages) setUnmappedStages(d.unmappedStages);
                          if (d.allStageMappings) setAllStageMappings(d.allStageMappings);
                        }
                      })
                      .catch(() => {})
                      .finally(() => setLoading(false));
                  }
                }}
                className="rounded border-white/20 bg-white/5 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-slate-400">Compare to previous period</span>
            </label>
            </>
            )}
            {activeTab === "monthly" && (
            <>
              <div className="min-w-[200px]">
                <label className="mb-1.5 block text-sm font-medium text-slate-400">
                  Facebook Ad Account ID
                </label>
                <input
                  type="text"
                  placeholder={sheetConfigLoaded ? "Not found in sheet" : "Loading…"}
                  value={settings?.facebookAdAccountId ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSettings((prev) =>
                      prev ? { ...prev, facebookAdAccountId: v || null } : prev
                    );
                  }}
                  onBlur={(e) => {
                    const v = (e.target.value ?? "").trim();
                    if (!locationId) return;
                    fetch(`/api/location/${locationId}/settings`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        facebookAdAccountId: v || null,
                      }),
                    })
                      .then((res) => (res.ok ? res.json() : null))
                      .then((s) => s && setSettings((prev) => (prev ? { ...prev, ...s } : prev)))
                      .catch(() => {});
                  }}
                  className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                {sheetConfigLoaded && !settings?.facebookAdAccountId && sheetLookupDebug && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-amber-400 hover:text-amber-300">
                      Why not found?
                    </summary>
                    <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200/90 space-y-1">
                      <p><strong>Searched for:</strong> {sheetLookupDebug.searchedFor}</p>
                      <p><strong>Reason:</strong> {sheetLookupDebug.reason}</p>
                      <p><strong>Sheet rows:</strong> {sheetLookupDebug.sheetRowCount}</p>
                      {sheetLookupDebug.locationIdColumnLetter != null && (
                        <p><strong>Location ID column:</strong> {sheetLookupDebug.locationIdColumnLetter} (index {sheetLookupDebug.locationIdColumnIndex})</p>
                      )}
                      {sheetLookupDebug.headerRow && sheetLookupDebug.headerRow.length > 0 && (
                        <div>
                          <p><strong>Header row (first 50 cols):</strong></p>
                          <pre className="mt-0.5 max-h-24 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all text-[10px] bg-black/20 rounded p-1.5">
                            {sheetLookupDebug.headerRow.slice(0, 50).map((h, i) => `${i}: ${h}`).join("\n")}
                          </pre>
                        </div>
                      )}
                      <div>
                        <p><strong>All IDs in column ({sheetLookupDebug.allLocationIdsFromSheet?.length ?? 0}):</strong></p>
                        <pre className="mt-0.5 max-h-48 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all text-[10px] bg-black/20 rounded p-1.5">
                          {sheetLookupDebug.allLocationIdsFromSheet?.length ? sheetLookupDebug.allLocationIdsFromSheet.join("\n") : "(none – column may be wrong or empty)"}
                        </pre>
                      </div>
                    </div>
                  </details>
                )}
              </div>
              <div className="min-w-[160px]">
                <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-400">
                  Campaign
                  <span
                    className="group relative inline-flex cursor-help"
                    title="Filter ad spend by campaign keyword from sheet"
                  >
                    <svg className="h-4 w-4 text-slate-500" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-48 -translate-x-1/2 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      Filter by keyword from sheet (All = total ad account spend)
                    </span>
                  </span>
                </label>
                <select
                  value={campaignKeyword}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCampaignKeyword(v);
                    if (locationId) {
                      fetch(`/api/location/${locationId}/settings`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ facebookCampaignKeyword: v || null }),
                      })
                        .then((res) => (res.ok ? res.json() : null))
                        .then((s) => s && setSettings((prev) => (prev ? { ...prev, ...s } : prev)))
                        .catch(() => {});
                    }
                  }}
                  disabled={!sheetConfigLoaded}
                  className="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                >
                  <option value="" className="bg-slate-900">
                    All
                  </option>
                  {sheetCampaignOptions.map((kw) => (
                    <option key={kw} value={kw} className="bg-slate-900">
                      {kw}
                    </option>
                  ))}
                </select>
              </div>
            </>
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

        {/* Tabs + Calculate dropdown */}
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
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm text-slate-400">
                Calculate:
                <span
                  className="group relative inline-flex cursor-help"
                  title="Show totals based on actual amount (On Totals) or current stage counts."
                >
                  <svg className="h-4 w-4 text-slate-500" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-72 -translate-x-1/2 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                    Show totals based on the actual amount (On Totals), considering that an opportunity was also a count for the previous stage. You can also show based on current stage count. Ex: 10 in Leads Stage & 10 in Appointments Stage, &quot;On Totals&quot; would display 20 Leads because those appointments were Leads as well.
                  </span>
                </span>
              </span>
              <select
                value={rollupAssumptions ? "onTotals" : "currentStageCounts"}
                onChange={(e) => {
                  const v = e.target.value === "onTotals";
                  setRollupAssumptions(v);
                  if (locationId) {
                    fetch(`/api/location/${locationId}/settings`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ rollupAssumptions: v }),
                    })
                      .then((res) => (res.ok ? res.json() : null))
                      .then((s) => s && setSettings((prev) => (prev ? { ...prev, rollupAssumptions: v } : prev)))
                      .catch(() => {});
                  }
                }}
                className="rounded border border-white/20 bg-white/5 px-2 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="onTotals">On Totals</option>
                <option value="currentStageCounts">Current Stage Counts</option>
              </select>
            </div>
            {activeTab === "monthly" && (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-sm text-slate-400">
                  Attribution:
                  <span
                    className="group relative inline-flex cursor-help"
                    title="Attribute opportunity to created date or last stage change."
                  >
                    <svg className="h-4 w-4 text-slate-500" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-72 -translate-x-1/2 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      If a Lead is generated in Jan, but closes in March, choose to attribute that to Jan (Date Created) or March (Last Updated).
                    </span>
                  </span>
                </span>
                <select
                  value={attributionMode}
                  onChange={(e) => {
                    const v = e.target.value as "created" | "lastUpdated";
                    setAttributionMode(v);
                    if (locationId) {
                      fetch(`/api/location/${locationId}/settings`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ attributionMode: v }),
                      })
                        .then((res) => (res.ok ? res.json() : null))
                        .then((s) => s && setSettings((prev) => (prev ? { ...prev, attributionMode: v } : prev)))
                        .catch(() => {});
                    }
                  }}
                  className="rounded border border-white/20 bg-white/5 px-2 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="lastUpdated">Last Updated</option>
                  <option value="created">Created</option>
                </select>
              </div>
            )}
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
              attributionMode={attributionMode}
              adSpend={
                settings?.facebookAdAccountId?.trim()
                  ? facebookAdSpend
                  : (settings?.adSpend?.[selectedPipelineId] ?? {})
              }
              adSpendLoading={!!(settings?.facebookAdAccountId?.trim() && facebookAdSpendLoading)}
              adSpendFromFacebook={!!settings?.facebookAdAccountId?.trim()}
              onAdSpendChange={(monthKey, value) => {
                if (!locationId || !selectedPipelineId || settings?.facebookAdAccountId?.trim()) return;
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
            <p className="mt-1 text-xs text-amber-200/70">
              If embedded in GHL, Connect opens the auth flow in the main window.
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
                  const prevMetrics = data.previousMetrics
                    ? (rollupAssumptions ? applyRollup(data.previousMetrics) : data.previousMetrics)
                    : null;
                  return (
              <>
                {/* Compact header */}
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-5 py-4">
                  <div>
                    <p className="text-sm text-slate-400">{data.pipeline.name}</p>
                    {data.dateRange && (
                      <p className="text-xs text-slate-500">
                        {formatDate(data.dateRange.startDate)} – {formatDate(data.dateRange.endDate)}
                        {data.previousDateRange && (
                          <span className="ml-2 text-slate-600">
                            vs {formatDate(data.previousDateRange.startDate)} – {formatDate(data.previousDateRange.endDate)}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {metrics.totalValue > 0 && (
                    <p className="text-xl font-semibold tabular-nums text-indigo-300">
                      ${formatCurrency(metrics.totalValue)} pipeline value
                    </p>
                  )}
                </div>

                {/* Comparison table when Compare is enabled */}
                {prevMetrics && (
                  <div className="overflow-hidden rounded-xl border border-white/10">
                    <table className="w-full min-w-[400px] text-sm">
                      <thead>
                        <tr className="border-b border-white/10 bg-white/5">
                          <th className="px-4 py-3 text-left font-medium text-slate-400">Metric</th>
                          <th className="px-4 py-3 text-right font-medium text-slate-400">
                            {data.dateRange && `${formatDate(data.dateRange.startDate)} – ${formatDate(data.dateRange.endDate)}`}
                          </th>
                          <th className="px-4 py-3 text-right font-medium text-slate-400">
                            {data.previousDateRange && `${formatDate(data.previousDateRange.startDate)} – ${formatDate(data.previousDateRange.endDate)}`}
                          </th>
                          <th className="px-4 py-3 text-right font-medium text-slate-400">Change</th>
                          <th className="px-4 py-3 text-right font-medium text-slate-400">Change(%)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {[
                          { key: "leads", label: "Leads", fmt: "num" as const },
                          { key: "totalAppts", label: "Appointments", fmt: "num" as const },
                          { key: "requested", label: "Requested", fmt: "num" as const },
                          { key: "confirmed", label: "Confirmed", fmt: "num" as const },
                          { key: "showed", label: "Showed", fmt: "num" as const },
                          { key: "noShow", label: "No Show", fmt: "num" as const },
                          { key: "closed", label: "Closed", fmt: "num" as const },
                          { key: "bookingRate", label: "Booking rate", fmt: "pct" as const },
                          { key: "confirmationRate", label: "Confirmation rate", fmt: "pct" as const },
                          { key: "showRate", label: "Show rate", fmt: "pct" as const },
                          { key: "showedConversionRate", label: "Showed conversions", fmt: "pct" as const },
                          { key: "totalValue", label: "Pipeline value", fmt: "currency" as const },
                        ].map(({ key, label, fmt }) => {
                          const curr = (metrics as unknown as Record<string, unknown>)[key] as number | null | undefined;
                          const prev = (prevMetrics as unknown as Record<string, unknown>)[key] as number | null | undefined;
                          const currVal = curr ?? 0;
                          const prevVal = prev ?? 0;
                          const change = typeof curr === "number" && typeof prev === "number" ? curr - prev : null;
                          const pctChange =
                            prevVal !== 0 && change !== null
                              ? Math.round((change / prevVal) * 10000) / 100
                              : prevVal === 0 && currVal > 0
                                ? 100
                                : prevVal === 0 && currVal === 0
                                  ? 0
                                  : null;
                          const formatVal = (v: number) =>
                            fmt === "pct" ? (v != null ? `${v}%` : "—") : fmt === "currency" ? `$${formatCurrency(v)}` : String(v ?? "—");
                          return (
                            <tr key={key} className="bg-white/[0.02]">
                              <td className="px-4 py-2.5 text-slate-300">{label}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-white">{formatVal(currVal)}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{formatVal(prevVal)}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {change !== null ? (
                                  <span className={change >= 0 ? "text-emerald-400" : "text-red-400"}>
                                    {fmt === "currency"
                                      ? `${change >= 0 ? "+" : "-"}$${formatCurrency(Math.abs(change))}`
                                      : fmt === "pct"
                                        ? `${change >= 0 ? "+" : ""}${Math.round(change * 10) / 10}pp`
                                        : `${change >= 0 ? "+" : ""}${change}`
                                  }
                                  </span>
                                ) : "—"}
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {pctChange !== null ? (
                                  <span className={pctChange >= 0 ? "text-emerald-400" : "text-red-400"}>
                                    {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange)}%
                                  </span>
                                ) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Leads accordion - shows Replied, Connected, New Lead, etc. */}
                {Object.keys(data.leadsBreakdown ?? {}).length > 0 && (
                  <details className="rounded-xl border border-white/10 bg-white/5">
                    <summary className="cursor-pointer px-5 py-4 text-sm text-slate-400 hover:text-slate-300">
                      Leads <span className="font-medium text-white">({metrics.leads})</span>
                    </summary>
                    <div className="border-t border-white/10 px-5 py-4">
                      <div className="flex flex-wrap gap-4 text-sm">
                        {Object.entries(data.leadsBreakdown ?? {}).map(([stage, count]) => (
                          <span key={stage}>
                            <span className="text-slate-500">{stage}:</span> {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
                {/* Appointments accordion - collapsed hides requested/confirmed/showed breakdown */}
                <details className="rounded-xl border border-white/10 bg-white/5">
                  <summary className="cursor-pointer px-5 py-4 text-sm text-slate-400 hover:text-slate-300">
                    Appointments <span className="font-medium text-white">({metrics.totalAppts})</span>
                  </summary>
                  <div className="border-t border-white/10 px-5 py-4">
                    <div className="flex flex-wrap gap-4 text-sm">
                      <span><span className="text-slate-500">Requested:</span> {metrics.requested}</span>
                      <span><span className="text-slate-500">Confirmed:</span> {metrics.confirmed}</span>
                      <span><span className="text-slate-500">Showed:</span> {metrics.showed}</span>
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
              {locationId && selectedPipelineId && (
                <p className="mt-4 text-slate-600">
                  <strong>Troubleshoot data fetch:</strong>{" "}
                  <a
                    href={`/api/debug/opportunities/${locationId}?pipelineId=${selectedPipelineId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-400 underline"
                  >
                    Open opportunities debug →
                  </a>
                </p>
              )}
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
  attributionMode,
  adSpend = {},
  adSpendLoading,
  adSpendFromFacebook,
  onAdSpendChange,
}: {
  months: MonthlyData[];
  locationId: string;
  pipelineId: string;
  rollupAssumptions: boolean;
  attributionMode: "created" | "lastUpdated";
  adSpend?: Record<string, number>;
  adSpendLoading?: boolean;
  adSpendFromFacebook?: boolean;
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
  const [drillDown, setDrillDown] = useState<{ label: string; monthKey: string; metric: string } | null>(null);
  const [drillDownNames, setDrillDownNames] = useState<string[]>([]);
  const [drillDownNamesByStage, setDrillDownNamesByStage] = useState<Record<string, string[]> | null>(null);
  const [drillDownLoading, setDrillDownLoading] = useState(false);

  const handleCellClick = (monthKey: string, metric: string, label: string) => {
    setDrillDown({ label, monthKey, metric });
    setDrillDownNames([]);
    setDrillDownNamesByStage(null);
    setDrillDownLoading(true);
    const params = new URLSearchParams({
      pipelineId,
      monthKey,
      metric,
      attribution: attributionMode,
      onTotals: String(rollupAssumptions),
    });
    fetch(`/api/conversions/${locationId}/opportunity-detail?${params}`)
      .then((r) => r.json())
      .then((d: { names?: string[]; namesByStage?: Record<string, string[]>; error?: string }) => {
        setDrillDownNames(d.names ?? []);
        setDrillDownNamesByStage(d.namesByStage ?? null);
      })
      .catch(() => {
        setDrillDownNames([]);
        setDrillDownNamesByStage(null);
      })
      .finally(() => setDrillDownLoading(false));
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <div className="px-5 py-4">
        <h2 className="text-lg font-semibold text-white">
          Month to Month Overview
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Attribution: {attributionMode === "lastUpdated" ? "Last Updated" : "Created"}
        </p>
      </div>
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
                Ad Spend
              </td>
              {months.map((m) => (
                <td key={m.monthKey} className="px-4 py-2 text-center">
                  {adSpendFromFacebook ? (
                    <span className="inline-flex w-20 items-center justify-center text-sm text-white">
                      {adSpendLoading ? (
                        <span
                          className="inline-block h-4 w-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin"
                          aria-hidden
                        />
                      ) : (adSpend[m.monthKey] ?? 0) > 0
                        ? "$" + Number(adSpend[m.monthKey]).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                        : "—"}
                    </span>
                  ) : (
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
                  )}
                </td>
              ))}
            </tr>
            <MetricRow
              label="Leads"
              values={months.map((m) => getMetrics(m).leads)}
              metric="leads"
              monthKeys={months.map((m) => m.monthKey)}
              onCellClick={handleCellClick}
            />
            <MetricRow
              label="Cost Per Lead"
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
              getMetrics={getMetrics}
              expanded={appointmentsExpanded}
              onToggle={() => setAppointmentsExpanded((e) => !e)}
              metric="totalAppts"
              onCellClick={handleCellClick}
            />
            {appointmentsExpanded && (
              <>
                <MetricRow
                  label="Appt Requested"
                  values={months.map((m) => getMetrics(m).requested)}
                  subRow
                  metric="requested"
                  monthKeys={months.map((m) => m.monthKey)}
                  onCellClick={handleCellClick}
                />
                <MetricRow
                  label="Appt Confirmed"
                  values={months.map((m) => getMetrics(m).confirmed)}
                  subRow
                  metric="confirmed"
                  monthKeys={months.map((m) => m.monthKey)}
                  onCellClick={handleCellClick}
                />
                <MetricRow
                  label="Show"
                  values={months.map((m) => getMetrics(m).showed)}
                  subRow
                  metric="showed"
                  monthKeys={months.map((m) => m.monthKey)}
                  onCellClick={handleCellClick}
                />
              </>
            )}
            <MetricRow
              label="No Show"
              values={months.map((m) => getMetrics(m).noShow)}
              metric="noShow"
              monthKeys={months.map((m) => m.monthKey)}
              onCellClick={handleCellClick}
            />
            <MetricRow
              label="Show %"
              values={months.map((m) => getMetrics(m).showRate)}
              format="percent"
            />
            <MetricRow
              label="Cost Per Show"
              values={months.map((m) => {
                const spend = adSpend[m.monthKey] ?? 0;
                const showed = getMetrics(m).showed;
                return showed > 0 && spend > 0 ? spend / showed : null;
              })}
              format="currency"
            />
            <MetricRow
              label="Closed"
              values={months.map((m) => getMetrics(m).closed)}
              metric="closed"
              monthKeys={months.map((m) => m.monthKey)}
              onCellClick={handleCellClick}
            />
            <MetricRow
              label="Cost Per Close"
              values={months.map((m) => {
                const spend = adSpend[m.monthKey] ?? 0;
                const closed = getMetrics(m).closed;
                return closed > 0 && spend > 0 ? spend / closed : null;
              })}
              format="currency"
            />
          </tbody>
        </table>
      </div>

      {drillDown && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setDrillDown(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-md rounded-xl border border-white/10 bg-slate-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <h3 className="font-semibold text-white">
                {drillDown.label} — {monthLabel(drillDown.monthKey)}
              </h3>
              <button
                type="button"
                onClick={() => setDrillDown(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              {drillDownLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                </div>
              ) : drillDownNamesByStage && Object.keys(drillDownNamesByStage).length > 0 ? (
                <div className="space-y-4">
                  {Object.entries(drillDownNamesByStage).map(([stageLabel, stageNames]) =>
                    stageNames.length > 0 ? (
                      <div key={stageLabel}>
                        <p className="mb-1.5 font-medium text-slate-200">{stageLabel}</p>
                        <ul className="space-y-1 text-sm text-slate-300">
                          {stageNames.map((name, i) => (
                            <li key={i} className="truncate pl-2">
                              • {name}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null
                  )}
                </div>
              ) : drillDownNames.length > 0 ? (
                <ul className="space-y-1.5 text-sm text-slate-300">
                  {drillDownNames.map((name, i) => (
                    <li key={i} className="truncate">
                      {name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-500">No opportunities found.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TotalAppointmentsRow({
  months,
  getMetrics,
  expanded,
  onToggle,
  metric,
  onCellClick,
}: {
  months: MonthlyData[];
  getMetrics?: (m: MonthlyData) => FunnelMetrics;
  expanded?: boolean;
  onToggle?: () => void;
  metric?: string;
  onCellClick?: (monthKey: string, metric: string, label: string) => void;
}) {
  const values = months.map((m) => {
    const metrics = getMetrics ? getMetrics(m) : m.metrics;
    return metrics.totalAppts ?? metrics.totalApptsRaw ?? metrics.requested + metrics.confirmed + metrics.showed;
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
          Appointments
        </button>
      </td>
      {values.map((v, i) => (
        <td key={i} className="px-4 py-2 text-center text-sm tabular-nums text-white">
          {metric && onCellClick && typeof v === "number" && v > 0 ? (
            <button
              type="button"
              onClick={() => onCellClick(months[i].monthKey, metric, "Appointments")}
              className="rounded px-1 py-0.5 text-indigo-300 hover:bg-indigo-500/20 hover:text-white underline decoration-dotted underline-offset-2"
            >
              {v}
            </button>
          ) : (
            v
          )}
        </td>
      ))}
    </tr>
  );
}

function MetricRow({
  label,
  values,
  format = "number",
  subRow,
  metric,
  monthKeys,
  onCellClick,
}: {
  label: string;
  values: (number | null)[];
  format?: "number" | "percent" | "currency";
  subRow?: boolean;
  metric?: string;
  monthKeys?: string[];
  onCellClick?: (monthKey: string, metric: string, label: string) => void;
}) {
  const fmt = (v: number | null) => {
    if (v == null) return "—";
    if (format === "percent") return `${v}%`;
    if (format === "currency") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return String(v);
  };
  const clickable = metric && monthKeys && onCellClick && format === "number";
  return (
    <tr className={subRow ? "bg-slate-800/60" : undefined}>
      <td className={`sticky left-0 z-10 px-4 py-2 text-sm text-slate-300 ${subRow ? "pl-8 bg-slate-800/60" : "bg-slate-900/95"}`}>
        {label}
      </td>
      {values.map((v, i) => (
        <td key={i} className={`px-4 py-2 text-center text-sm tabular-nums text-white ${subRow ? "bg-slate-800/60" : ""}`}>
          {clickable && typeof v === "number" && v > 0 && monthKeys[i] ? (
            <button
              type="button"
              onClick={() => onCellClick(monthKeys[i], metric, label)}
              className="rounded px-1 py-0.5 text-indigo-300 hover:bg-indigo-500/20 hover:text-white underline decoration-dotted underline-offset-2"
            >
              {fmt(v)}
            </button>
          ) : (
            fmt(v)
          )}
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

