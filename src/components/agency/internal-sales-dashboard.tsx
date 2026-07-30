"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";
import type {
  AttributionBreakdownRow,
  AttributionDimension,
  AttributionFilterOptions,
  InternalSalesMetrics,
  InternalSalesMonthRow,
} from "@/lib/internal-sales-metrics";
import {
  BLANK_ATTR,
  countDelta,
  rateDelta,
} from "@/lib/internal-sales-metrics";
type SpendCosts = {
  spend: number;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
};

type Tab = "funnel" | "monthly" | "attribution";

interface SharedMeta {
  rowCount: number;
  filteredRowCount?: number;
  fetchedAt: number;
  fromCache: boolean;
  filters?: {
    campaigns: string[];
    adSets: string[];
    ads: string[];
    sources: string[];
  };
  filterOptions?: AttributionFilterOptions;
  filterDateSpan?: { min: string; max: string } | null;
  adAccountId?: string;
  metaSpendError?: string;
  warning?: string;
  error?: string;
}

interface FunnelResponse extends SharedMeta {
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
  costs: SpendCosts | null;
  previousCosts: SpendCosts | null;
}

interface MonthlyMonthRow extends InternalSalesMonthRow {
  spend?: number;
  costs?: SpendCosts;
}

interface MonthlyResponse extends SharedMeta {
  view: "monthly";
  months: MonthlyMonthRow[];
}

interface AttributionRow extends AttributionBreakdownRow {
  spend: number | null;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
}

interface AttributionResponse extends SharedMeta {
  view: "attribution";
  dimension: AttributionDimension;
  range: {
    preset: DateRangePreset;
    startDate: string;
    endDate: string;
    label: string;
  };
  rows: AttributionRow[];
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

const DIMENSION_OPTIONS: { id: AttributionDimension; label: string }[] = [
  { id: "ad", label: "Ad" },
  { id: "adSet", label: "Ad set" },
  { id: "campaign", label: "Campaign" },
  { id: "source", label: "Source" },
];

type AttrSortKey =
  | "key"
  | "spend"
  | "leads"
  | "cpl"
  | "booked"
  | "bookingRate"
  | "showed"
  | "showRate"
  | "signed"
  | "closeRate";

function formatPct(v: number | null): string {
  if (v == null) return "—";
  return `${v}%`;
}

function formatMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function formatMoneyExact(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

function optionLabel(value: string): string {
  return value === BLANK_ATTR ? "(none)" : value;
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

const selectClass =
  "mt-1 block max-w-[220px] rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white";

function MultiFilterSelect({
  label,
  options,
  selected,
  onChange,
  allLabel,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? optionLabel(selected[0])
        : `${selected.length} selected`;

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <div className="relative block text-xs text-slate-400" ref={rootRef}>
      {label}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${selectClass} flex w-[220px] items-center justify-between gap-2 text-left`}
      >
        <span className="truncate text-white">{summary}</span>
        <span className="text-slate-500" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="absolute z-30 mt-1 max-h-64 w-[280px] overflow-auto rounded-lg border border-white/10 bg-slate-950 py-1 shadow-xl shadow-black/40">
          <button
            type="button"
            onClick={() => onChange([])}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/5 ${
              selected.length === 0 ? "text-indigo-300" : "text-slate-300"
            }`}
          >
            {allLabel}
          </button>
          {options.map((v) => {
            const checked = selected.includes(v);
            return (
              <label
                key={v}
                className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(v)}
                  className="mt-0.5 rounded border-white/20 bg-slate-900"
                />
                <span className="min-w-0 break-words">{optionLabel(v)}</span>
              </label>
            );
          })}
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">No options</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function InternalSalesDashboard() {
  const [tab, setTab] = useState<Tab>("funnel");
  const [preset, setPreset] = useState<DateRangePreset>("last_30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [campaigns, setCampaigns] = useState<string[]>([]);
  const [adSets, setAdSets] = useState<string[]>([]);
  const [ads, setAds] = useState<string[]>([]);
  const [dimension, setDimension] = useState<AttributionDimension>("ad");
  const [sortKey, setSortKey] = useState<AttrSortKey>("signed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [monthly, setMonthly] = useState<MonthlyResponse | null>(null);
  const [attribution, setAttribution] = useState<AttributionResponse | null>(
    null
  );
  const [filterOptions, setFilterOptions] =
    useState<AttributionFilterOptions | null>(null);
  /** Prevents repeat auto-fit for the same filter + span. */
  const autoFitKeyRef = useRef("");

  const appendFilters = useCallback(
    (params: URLSearchParams) => {
      for (const v of campaigns) params.append("campaign", v);
      for (const v of adSets) params.append("adSet", v);
      for (const v of ads) params.append("ad", v);
    },
    [campaigns, adSets, ads]
  );

  const fetchFunnel = useCallback(
    async (
      nextPreset: DateRangePreset,
      from?: string,
      to?: string,
      nextCompare?: boolean,
      allowAutoFit = true
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
      appendFilters(params);
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
        if (body.filterOptions) setFilterOptions(body.filterOptions);

        const filterActive = !!(
          body.filters?.campaigns?.length ||
          body.filters?.adSets?.length ||
          body.filters?.ads?.length
        );
        const span = body.filterDateSpan;
        // If the filter matches rows but none sit in the selected date window,
        // jump the range to those appointment dates so the UI isn't empty zeros.
        if (
          allowAutoFit &&
          filterActive &&
          body.metrics.counts.leads === 0 &&
          (body.filteredRowCount ?? 0) > 0 &&
          span?.min &&
          span?.max
        ) {
          const fitKey = `${(body.filters?.campaigns ?? []).join("|")}::${(
            body.filters?.adSets ?? []
          ).join("|")}::${(body.filters?.ads ?? []).join("|")}::${span.min}::${span.max}`;
          if (autoFitKeyRef.current !== fitKey) {
            autoFitKeyRef.current = fitKey;
            setPreset("custom");
            setCustomFrom(span.min);
            setCustomTo(span.max);

            const fitParams = new URLSearchParams();
            fitParams.set("view", "funnel");
            fitParams.set("preset", "custom");
            fitParams.set("clientDate", getTodayLocal());
            fitParams.set("dateFrom", span.min);
            fitParams.set("dateTo", span.max);
            if (nextCompare) fitParams.set("compare", "true");
            appendFilters(fitParams);
            const fitRes = await fetch(
              `/api/agency/internal-sales?${fitParams.toString()}`,
              { cache: "no-store" }
            );
            const fitBody = (await fitRes.json()) as FunnelResponse;
            if (!fitRes.ok) {
              setError(fitBody.error || "Failed to load");
              return;
            }
            if (fitBody.filterOptions) setFilterOptions(fitBody.filterOptions);
            setFunnel(fitBody);
            return;
          }
        }

        setFunnel(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [appendFilters]
  );

  const fetchMonthly = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("view", "monthly");
    params.set("months", "13");
    params.set("clientDate", getTodayLocal());
    appendFilters(params);
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
      if (body.filterOptions) setFilterOptions(body.filterOptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [appendFilters]);

  const fetchAttribution = useCallback(
    async (
      nextPreset: DateRangePreset,
      nextDimension: AttributionDimension,
      from?: string,
      to?: string
    ) => {
      if (nextPreset === "custom" && (!from || !to)) return;
      const params = new URLSearchParams();
      params.set("view", "attribution");
      params.set("preset", nextPreset);
      params.set("dimension", nextDimension);
      params.set("clientDate", getTodayLocal());
      if (nextPreset === "custom" && from && to) {
        params.set("dateFrom", from);
        params.set("dateTo", to);
      }
      appendFilters(params);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/agency/internal-sales?${params.toString()}`,
          { cache: "no-store" }
        );
        const body = (await res.json()) as AttributionResponse;
        if (!res.ok) {
          setError(body.error || "Failed to load");
          return;
        }
        setAttribution(body);
        if (body.filterOptions) setFilterOptions(body.filterOptions);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    },
    [appendFilters]
  );

  const refetchActive = useCallback(() => {
    if (tab === "monthly") void fetchMonthly();
    else if (tab === "attribution")
      void fetchAttribution(preset, dimension, customFrom, customTo);
    else void fetchFunnel(preset, customFrom, customTo, compare);
  }, [
    tab,
    fetchMonthly,
    fetchAttribution,
    fetchFunnel,
    preset,
    dimension,
    customFrom,
    customTo,
    compare,
  ]);

  useEffect(() => {
    void fetchFunnel("last_30", undefined, undefined, false);
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as DateRangePreset;
    setPreset(next);
    if (next === "custom") return;
    if (tab === "attribution") {
      void fetchAttribution(next, dimension, customFrom, customTo);
    } else if (tab === "funnel") {
      void fetchFunnel(next, customFrom, customTo, compare);
    }
  };

  const handleCustomApply = () => {
    if (!customFrom || !customTo) return;
    if (tab === "attribution") {
      void fetchAttribution("custom", dimension, customFrom, customTo);
    } else {
      void fetchFunnel("custom", customFrom, customTo, compare);
    }
  };

  const handleCompareToggle = (checked: boolean) => {
    setCompare(checked);
    void fetchFunnel(preset, customFrom, customTo, checked);
  };

  const handleTabChange = (next: Tab) => {
    setTab(next);
    if (next === "monthly") void fetchMonthly();
    else if (next === "attribution")
      void fetchAttribution(preset, dimension, customFrom, customTo);
    else void fetchFunnel(preset, customFrom, customTo, compare);
  };

  // Filter state updates are applied on next fetch via appendFilters.
  // Schedule refetch after state commits.
  useEffect(() => {
    // Skip the first render (initial fetch handles that).
    if (!filterOptions) return;
    autoFitKeyRef.current = "";
    refetchActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns, adSets, ads]);

  const handleCampaignsChange = (next: string[]) => {
    setCampaigns(next);
    setAdSets([]);
    setAds([]);
  };

  const handleAdSetsChange = (next: string[]) => {
    setAdSets(next);
    setAds([]);
  };

  const clearFilters = () => {
    autoFitKeyRef.current = "";
    setCampaigns([]);
    setAdSets([]);
    setAds([]);
  };

  const applyMatchingDateSpan = (span?: { min: string; max: string } | null) => {
    if (!span?.min || !span?.max) {
      setPreset("maximum");
      void fetchFunnel("maximum", undefined, undefined, compare, false);
      return;
    }
    autoFitKeyRef.current = `${campaigns.join("|")}::${adSets.join("|")}::${ads.join("|")}::${span.min}::${span.max}`;
    setPreset("custom");
    setCustomFrom(span.min);
    setCustomTo(span.max);
    void fetchFunnel("custom", span.min, span.max, compare, false);
  };

  const hasFilters = campaigns.length > 0 || adSets.length > 0 || ads.length > 0;

  const sortedAttributionRows = useMemo(() => {
    const rows = attribution?.rows ?? [];
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (row: AttributionRow): number => {
      switch (sortKey) {
        case "spend":
          return row.spend ?? -1;
        case "cpl":
          return row.cpl ?? -1;
        case "leads":
          return row.metrics.counts.leads;
        case "booked":
          return row.metrics.counts.booked;
        case "showed":
          return row.metrics.counts.showed;
        case "signed":
          return row.metrics.counts.signed;
        case "bookingRate":
          return row.metrics.rates.bookingRate ?? -1;
        case "showRate":
          return row.metrics.rates.showRate ?? -1;
        case "closeRate":
          return row.metrics.rates.closeRate ?? -1;
        default:
          return 0;
      }
    };
    return [...rows].sort((a, b) => {
      if (sortKey === "key") {
        return (
          a.label.localeCompare(b.label, undefined, {
            sensitivity: "base",
          }) * dir
        );
      }
      const av = val(a);
      const bv = val(b);
      if (av === bv) return a.label.localeCompare(b.label);
      return av < bv ? -dir : dir;
    });
  }, [attribution?.rows, sortKey, sortDir]);

  const handleSort = (key: AttrSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "key" ? "asc" : "desc");
    }
  };

  const m = funnel?.metrics;
  const prev = funnel?.previousMetrics;
  const costs = funnel?.costs;
  const prevCosts = funnel?.previousCosts;
  const c = m?.counts;
  const r = m?.rates;
  const options = filterOptions;
  const showDateControls = tab === "funnel" || tab === "attribution";
  const spendError =
    funnel?.metaSpendError ||
    monthly?.metaSpendError ||
    attribution?.metaSpendError;

  const SortTh = ({
    k,
    children,
    align = "center",
  }: {
    k: AttrSortKey;
    children: React.ReactNode;
    align?: "left" | "center";
  }) => (
    <th
      className={`px-3 py-3 text-xs font-medium uppercase tracking-wider text-slate-400 ${
        align === "left" ? "text-left" : "text-center"
      }`}
    >
      <button
        type="button"
        onClick={() => handleSort(k)}
        className="inline-flex items-center gap-1 hover:text-white"
      >
        {children}
        {sortKey === k ? (
          <span className="text-indigo-400" aria-hidden>
            {sortDir === "desc" ? "↓" : "↑"}
          </span>
        ) : null}
      </button>
    </th>
  );

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

        {showDateControls ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-xs text-slate-400">
              Date range
              <select
                value={preset}
                onChange={handlePresetChange}
                className={selectClass}
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
                    className={selectClass}
                  />
                </label>
                <label className="block text-xs text-slate-400">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className={selectClass}
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
            {tab === "funnel" ? (
              <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={compare}
                  onChange={(e) => handleCompareToggle(e.target.checked)}
                  className="rounded border-white/20 bg-slate-900"
                />
                Compare prior period
              </label>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-slate-900/30 px-4 py-3">
        <MultiFilterSelect
          label="Campaign"
          allLabel="All campaigns"
          options={options?.campaigns ?? []}
          selected={campaigns}
          onChange={handleCampaignsChange}
        />
        <MultiFilterSelect
          label="Ad set"
          allLabel="All ad sets"
          options={options?.adSets ?? []}
          selected={adSets}
          onChange={handleAdSetsChange}
        />
        <MultiFilterSelect
          label="Ad"
          allLabel="All ads"
          options={options?.ads ?? []}
          selected={ads}
          onChange={setAds}
        />
        {hasFilters ? (
          <button
            type="button"
            onClick={clearFilters}
            className="mb-0.5 rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="mt-6 flex gap-1 rounded-lg bg-slate-800/50 p-1 w-fit">
        {(
          [
            { id: "funnel" as const, label: "Funnel" },
            { id: "attribution" as const, label: "By ad" },
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

      {funnel?.warning || monthly?.warning || attribution?.warning ? (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {funnel?.warning || monthly?.warning || attribution?.warning}
        </div>
      ) : null}

      {spendError ? (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          Meta spend unavailable: {spendError}
        </div>
      ) : null}

      {loading && !funnel && !monthly && !attribution ? (
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
              {` · ${c.leads} leads in range`}
              {hasFilters &&
              funnel.filteredRowCount != null &&
              funnel.filteredRowCount > c.leads
                ? ` · ${funnel.filteredRowCount} match filter overall`
                : null}
              {funnel.rowCount ? ` · ${funnel.rowCount} total rows` : null}
            </p>
          ) : null}

          {hasFilters &&
          c.leads === 0 &&
          (funnel?.filteredRowCount ?? 0) > 0 ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
              <p>
                {funnel?.filteredRowCount} row
                {funnel?.filteredRowCount === 1 ? "" : "s"} match this filter,
                but none fall in {funnel?.range.label.toLowerCase() ?? "this range"}
                {funnel?.filterDateSpan
                  ? ` (matching dates: ${funnel.filterDateSpan.min} → ${funnel.filterDateSpan.max})`
                  : ""}
                .
              </p>
              <button
                type="button"
                onClick={() => applyMatchingDateSpan(funnel?.filterDateSpan)}
                className="mt-2 rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-50 hover:bg-amber-500/30"
              >
                Show matching dates
                {funnel?.filterDateSpan
                  ? ` (${funnel.filterDateSpan.min} → ${funnel.filterDateSpan.max})`
                  : ""}
              </button>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Ad spend"
              value={formatMoney(costs?.spend ?? null)}
              delta={
                compare && costs && prevCosts
                  ? countDelta(
                      Math.round(costs.spend),
                      Math.round(prevCosts.spend)
                    )
                  : undefined
              }
              sub={
                funnel?.adAccountId
                  ? funnel.adAccountId.replace(/^act_/, "act_")
                  : undefined
              }
            />
            <KpiCard
              label="Cost per lead"
              value={formatMoneyExact(costs?.cpl ?? null)}
            />
            <KpiCard
              label="Cost per show"
              value={formatMoneyExact(costs?.cps ?? null)}
            />
            <KpiCard
              label="Cost per close"
              value={formatMoneyExact(costs?.cpClose ?? null)}
            />
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

      {tab === "attribution" && attribution ? (
        <div className={`mt-8 space-y-4 ${loading ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs text-slate-500">
                {attribution.range.label} · {attribution.range.startDate} →{" "}
                {attribution.range.endDate}
                {attribution.filteredRowCount != null &&
                attribution.filteredRowCount !== attribution.rowCount
                  ? ` · ${attribution.filteredRowCount} of ${attribution.rowCount} rows`
                  : null}
              </p>
            </div>
            <label className="block text-xs text-slate-400">
              Group by
              <select
                value={dimension}
                onChange={(e) => {
                  const next = e.target.value as AttributionDimension;
                  setDimension(next);
                  void fetchAttribution(preset, next, customFrom, customTo);
                }}
                className={selectClass}
              >
                {DIMENSION_OPTIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {sortedAttributionRows.length === 0 ? (
            hasFilters && (attribution?.filteredRowCount ?? 0) > 0 ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
                <p>
                  {attribution?.filteredRowCount} row
                  {attribution?.filteredRowCount === 1 ? "" : "s"} match this
                  filter, but none fall in{" "}
                  {attribution?.range.label.toLowerCase() ?? "this range"}
                  {attribution?.filterDateSpan
                    ? ` (matching dates: ${attribution.filterDateSpan.min} → ${attribution.filterDateSpan.max})`
                    : ""}
                  .
                </p>
                <button
                  type="button"
                  onClick={() => {
                    applyMatchingDateSpan(attribution?.filterDateSpan);
                    setTab("funnel");
                  }}
                  className="mt-2 rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-50 hover:bg-amber-500/30"
                >
                  Show matching dates
                  {attribution?.filterDateSpan
                    ? ` (${attribution.filterDateSpan.min} → ${attribution.filterDateSpan.max})`
                    : ""}
                </button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                No rows for this range and filter.
              </p>
            )
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <SortTh k="key" align="left">
                      {DIMENSION_OPTIONS.find((d) => d.id === dimension)
                        ?.label ?? "Name"}
                    </SortTh>
                    <SortTh k="spend">Spend</SortTh>
                    <SortTh k="leads">Leads</SortTh>
                    <SortTh k="cpl">CPL</SortTh>
                    <SortTh k="booked">Appts</SortTh>
                    <SortTh k="bookingRate">Book %</SortTh>
                    <SortTh k="showed">Showed</SortTh>
                    <SortTh k="showRate">Show %</SortTh>
                    <SortTh k="signed">Signed</SortTh>
                    <SortTh k="closeRate">Close %</SortTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {sortedAttributionRows.map((row) => (
                    <tr key={row.key} className="hover:bg-white/[0.03]">
                      <td
                        className="max-w-xs px-3 py-2.5 text-slate-200"
                        title={row.label}
                      >
                        <span className="line-clamp-2">{row.label}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {formatMoney(row.spend)}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {row.metrics.counts.leads}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {formatMoneyExact(row.cpl)}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {row.metrics.counts.booked}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {formatPct(row.metrics.rates.bookingRate)}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {row.metrics.counts.showed}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {formatPct(row.metrics.rates.showRate)}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {row.metrics.counts.signed}
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">
                        {formatPct(row.metrics.rates.closeRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                {hasFilters ? " · filtered" : ""}
              </p>
            </div>
            <div className="overflow-x-auto pb-5">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="sticky left-0 z-10 min-w-[160px] bg-slate-900/95 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                      Metric
                    </th>
                    {monthly.months.map((month) => {
                      const [y, mo] = month.monthKey.split("-").map(Number);
                      return (
                        <th
                          key={month.monthKey}
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
                    label="Ad Spend"
                    values={monthly.months.map((x) => x.costs?.spend ?? x.spend ?? null)}
                    format="currency"
                  />
                  <SalesMetricRow
                    label="Leads"
                    values={monthly.months.map((x) => x.metrics.counts.leads)}
                  />
                  <SalesMetricRow
                    label="Cost Per Lead"
                    values={monthly.months.map((x) => x.costs?.cpl ?? null)}
                    format="currency"
                  />
                  <SalesMetricRow
                    label="Booking %"
                    values={monthly.months.map(
                      (x) => x.metrics.rates.bookingRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Appointments"
                    values={monthly.months.map((x) => x.metrics.counts.booked)}
                  />
                  <SalesMetricRow
                    label="Showed"
                    values={monthly.months.map((x) => x.metrics.counts.showed)}
                  />
                  <SalesMetricRow
                    label="No Show"
                    values={monthly.months.map(
                      (x) => x.metrics.counts.noShowed
                    )}
                  />
                  <SalesMetricRow
                    label="Cancelled"
                    values={monthly.months.map(
                      (x) => x.metrics.counts.cancelled
                    )}
                  />
                  <SalesMetricRow
                    label="Show %"
                    values={monthly.months.map((x) => x.metrics.rates.showRate)}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Cost Per Show"
                    values={monthly.months.map((x) => x.costs?.cps ?? null)}
                    format="currency"
                  />
                  <SalesMetricRow
                    label="Signed"
                    values={monthly.months.map((x) => x.metrics.counts.signed)}
                  />
                  <SalesMetricRow
                    label="Close %"
                    values={monthly.months.map(
                      (x) => x.metrics.rates.closeRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Cost Per Close"
                    values={monthly.months.map((x) => x.costs?.cpClose ?? null)}
                    format="currency"
                  />
                  <SalesMetricRow
                    label="Qualified %"
                    values={monthly.months.map(
                      (x) => x.metrics.rates.qualifiedRate
                    )}
                    format="percent"
                  />
                  <SalesMetricRow
                    label="Pipeline"
                    values={monthly.months.map(
                      (x) => x.metrics.counts.pipeline
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
  format?: "number" | "percent" | "currency";
}) {
  const fmt = (v: number | null) => {
    if (v == null) return "—";
    if (format === "percent") return `${v}%`;
    if (format === "currency") {
      if (v === 0) return "—";
      return `$${v.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}`;
    }
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
