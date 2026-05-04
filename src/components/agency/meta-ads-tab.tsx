"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";
import {
  formatCount,
  formatDateTime,
  formatMoney,
  formatMoneyDecimal,
  formatPercent,
} from "./format";

const DATE_RANGE_ORDER: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

type SortKey =
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "inlineLinkClicks"
  | "ctr"
  | "cpc"
  | "cpm"
  | "leads"
  | "cpl"
  | "adName"
  | "businessName"
  | "campaignName";

interface MetaAdsRange {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
  label: string;
}

interface MetaAdsMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  leads: number;
  frequency?: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
}

interface MetaAdsPhrase {
  id: number;
  phrase: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MetaAdsRollup extends MetaAdsMetrics {
  id: number;
  label: string;
  phrase: string;
  enabled: boolean;
  adCount: number;
}

interface MetaAdsRow extends MetaAdsMetrics {
  rowKey: string;
  adId: string;
  adName: string;
  adsetName: string | null;
  campaignName: string | null;
  thumbnailUrl: string | null;
  adsManagerUrl: string | null;
  locationId: string;
  campaignKey: string;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  status: "ACTIVE" | "2ND CMPN";
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  adAccountId: string;
}

type AdsTableRow =
  | ({ rowType: "rollup"; children: Array<MetaAdsRow & { matchingRollups: MetaAdsRollup[] }> } & MetaAdsRollup)
  | ({ rowType: "ad"; matchingRollups: MetaAdsRollup[] } & MetaAdsRow);

interface MetaAdsResponse {
  snapshot?: { id: number } | null;
  cached: boolean;
  range?: MetaAdsRange;
  recentSpendMonths?: number;
  accountCount?: number;
  eligibleAccountCount?: number;
  sheetCampaignCount?: number;
  eligibleCampaignCount?: number;
  rowCount?: number;
  refreshedAt?: string;
  totals?: MetaAdsMetrics;
  phrases: MetaAdsPhrase[];
  rollups: MetaAdsRollup[];
  rows: MetaAdsRow[];
  warnings?: Array<{
    adAccountId?: string;
    campaignKey?: string;
    message: string;
  }>;
  error?: string;
}

interface AppliedRange {
  preset: DateRangePreset;
  from: string;
  to: string;
}

const SORT_LABELS: Record<SortKey, string> = {
  spend: "Spend",
  impressions: "Impr.",
  reach: "Reach",
  clicks: "Clicks",
  inlineLinkClicks: "Link clicks",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  leads: "Leads",
  cpl: "CPL",
  adName: "Ad",
  businessName: "Client",
  campaignName: "Campaign",
};

export function MetaAdsTab() {
  const [dateRangePreset, setDateRangePreset] =
    useState<DateRangePreset>("last_30");
  const [customDateFrom, setCustomDateFrom] = useState("");
  const [customDateTo, setCustomDateTo] = useState("");
  const [appliedRange, setAppliedRange] = useState<AppliedRange>({
    preset: "last_30",
    from: "",
    to: "",
  });
  const [data, setData] = useState<MetaAdsResponse | null>(null);
  const [loadingCache, setLoadingCache] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingRollup, setSavingRollup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newPhrase, setNewPhrase] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRollups, setExpandedRollups] = useState<Set<number>>(new Set());

  const requestAds = useCallback(
    (range: AppliedRange, method: "GET" | "POST", signal?: AbortSignal) => {
      const params = new URLSearchParams({
        preset: range.preset,
        clientDate: getTodayLocal(),
      });
      if (range.preset === "custom") {
        params.set("from", range.from);
        params.set("to", range.to);
      }

      if (method === "POST") setRefreshing(true);
      else setLoadingCache(true);
      setError(null);

      fetch(`/api/agency/meta/ads?${params.toString()}`, {
        method,
        cache: "no-store",
        signal,
      })
        .then(async (res) => {
          const json = (await res.json()) as MetaAdsResponse;
          if (!res.ok) {
            throw new Error(json.error ?? "Failed to load Meta ads");
          }
          setData(json);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Meta ads");
        })
        .finally(() => {
          if (signal?.aborted) return;
          if (method === "POST") setRefreshing(false);
          else setLoadingCache(false);
        });
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    const id = window.setTimeout(() => {
      requestAds(appliedRange, "GET", controller.signal);
    }, 0);

    return () => {
      window.clearTimeout(id);
      controller.abort();
    };
  }, [appliedRange, requestAds]);

  const tableRows = useMemo<AdsTableRow[]>(() => {
    const activeRollups = data?.rollups.filter((rollup) => rollup.enabled) ?? [];
    const adRowsWithMembership =
      data?.rows.map((row) => ({
        ...row,
        rowType: "ad" as const,
        matchingRollups: activeRollups.filter((rollup) =>
          row.adName.toLowerCase().includes(rollup.phrase.toLowerCase())
        ),
      })) ?? [];
    const rollupRows: AdsTableRow[] =
      activeRollups.map((rollup) => ({
        ...rollup,
        rowType: "rollup" as const,
        children: adRowsWithMembership.filter((row) =>
          row.matchingRollups.some((match) => match.id === rollup.id)
        ),
      })) ?? [];
    const ungroupedAdRows: AdsTableRow[] =
      adRowsWithMembership
        .filter((row) => row.matchingRollups.length === 0)
        .map((row) => ({
          ...row,
        rowType: "ad" as const,
        }));
    return [...rollupRows, ...ungroupedAdRows];
  }, [data?.rollups, data?.rows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tableRows
      .filter((row) => {
        if (!query) return true;
        if (row.rowType === "rollup") {
          return (
            row.phrase.toLowerCase().includes(query) ||
            row.children.some((child) => adMatchesQuery(child, query))
          );
        }
        return adMatchesQuery(row, query);
      })
      .sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [search, sortDir, sortKey, tableRows]);

  const hasCache = Boolean(data?.cached && data.rows.length > 0);
  const activePhrases = data?.phrases.filter((p) => p.enabled).length ?? 0;
  const groupedAdCount = useMemo(() => {
    const ids = new Set<string>();
    for (const row of tableRows) {
      if (row.rowType !== "rollup") continue;
      for (const child of row.children) ids.add(child.rowKey);
    }
    return ids.size;
  }, [tableRows]);
  const loading = loadingCache || refreshing;
  const currentRangeLabel = data?.range
    ? `${data.range.startDate} -> ${data.range.endDate}`
    : DATE_RANGE_LABELS[appliedRange.preset];

  function handleDateRangeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const preset = e.target.value as DateRangePreset;
    setDateRangePreset(preset);
    if (preset !== "custom") {
      setAppliedRange({ preset, from: "", to: "" });
    }
  }

  function handleCustomDateApply() {
    if (!customDateFrom || !customDateTo) return;
    setAppliedRange({
      preset: "custom",
      from: customDateFrom,
      to: customDateTo,
    });
  }

  function handleRefresh() {
    requestAds(appliedRange, "POST");
  }

  async function reloadCacheAfterRollupChange() {
    requestAds(appliedRange, "GET");
  }

  async function handleAddPhrase() {
    const phrase = newPhrase.trim();
    if (!phrase) return;
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/ad-rollups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to add rollup");
      setNewPhrase("");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleTogglePhrase(phrase: MetaAdsPhrase) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/ad-rollups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: phrase.id, enabled: !phrase.enabled }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to update rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleDeletePhrase(phrase: MetaAdsPhrase) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch(`/api/agency/meta/ad-rollups?id=${phrase.id}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to delete rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setSortDir("desc");
  }

  function toggleRollup(id: number) {
    setExpandedRollups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Meta ad creative performance
            </div>
            <div className="mt-1 text-lg font-semibold text-white">
              {currentRangeLabel}
              {loadingCache && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  checking cache...
                </span>
              )}
              {refreshing && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  refreshing from Meta...
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {hasCache
                ? `${formatCount(data?.rowCount)} cached ads from ${data?.eligibleAccountCount}/${data?.accountCount} recent-spend accounts. Last refreshed ${formatDateTime(data?.refreshedAt)}.`
                : "No cached Meta ads for this date range yet. Click Refresh Meta ads to pull and cache it."}
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
                disabled={loading}
                className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {DATE_RANGE_ORDER.map((p) => (
                  <option key={p} value={p} className="bg-slate-900 text-white">
                    {DATE_RANGE_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            {dateRangePreset === "custom" && (
              <div className="flex items-end gap-2">
                <DateInput
                  label="From"
                  value={customDateFrom}
                  onChange={setCustomDateFrom}
                />
                <DateInput
                  label="To"
                  value={customDateTo}
                  onChange={setCustomDateTo}
                />
                <button
                  type="button"
                  onClick={handleCustomDateApply}
                  disabled={!customDateFrom || !customDateTo || loading}
                  className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {hasCache ? "Refresh Meta ads" : "Load Meta ads"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            {error}
          </div>
        )}

        {data?.warnings?.length ? (
          <details className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-100">
            <summary className="cursor-pointer font-medium">
              {data.warnings.length} Meta warning
              {data.warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-1">
              {data.warnings.slice(0, 8).map((warning, idx) => (
                <li key={`${warning.campaignKey ?? warning.adAccountId ?? idx}`}>
                  {warning.campaignKey ? `${warning.campaignKey}: ` : ""}
                  {warning.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {hasCache && data?.totals && (
        <>
          <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <SummaryCard label="Spend" value={formatMoney(data.totals.spend)} />
            <SummaryCard
              label="Link clicks"
              value={formatCount(data.totals.inlineLinkClicks)}
            />
            <SummaryCard label="Leads" value={formatCount(data.totals.leads)} />
            <SummaryCard label="CPL" value={formatMoneyDecimal(data.totals.cpl)} />
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/30 p-4">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Ads leaderboard
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Showing {formatCount(filteredRows.length)} top-level rows:{" "}
                  {formatCount(groupedAdCount)} ads grouped into {activePhrases}{" "}
                  active rollups; ungrouped ads remain below.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Add rollup phrase
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newPhrase}
                      onChange={(e) => setNewPhrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddPhrase();
                        }
                      }}
                      placeholder="shoulderimage"
                      disabled={savingRollup}
                      className="w-48 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddPhrase()}
                      disabled={!newPhrase.trim() || savingRollup}
                      className="rounded-lg bg-slate-800 px-3 py-2 font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Search
                  </label>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Ad, ad set, campaign, client..."
                    className="w-72 max-w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>
            </div>

            <RollupPhraseChips
              phrases={data.phrases}
              disabled={savingRollup}
              onToggle={(phrase) => void handleTogglePhrase(phrase)}
              onDelete={(phrase) => void handleDeletePhrase(phrase)}
            />

            <div className="max-w-full overflow-x-auto rounded-xl border border-white/10 bg-slate-900/30">
              <table className="w-max min-w-full border-separate border-spacing-0 divide-y divide-white/5 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                    <SortableTh
                      label="Ad"
                      active={sortKey === "adName"}
                      dir={sortDir}
                      onClick={() => handleSort("adName")}
                      sticky
                    />
                    <SortableTh
                      label="Client"
                      active={sortKey === "businessName"}
                      dir={sortDir}
                      onClick={() => handleSort("businessName")}
                    />
                    <SortableTh
                      label="Campaign"
                      active={sortKey === "campaignName"}
                      dir={sortDir}
                      onClick={() => handleSort("campaignName")}
                    />
                    <th className="sticky top-0 z-20 border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
                      Ad set
                    </th>
                    {(
                      [
                        "spend",
                        "impressions",
                        "reach",
                        "inlineLinkClicks",
                        "ctr",
                        "cpc",
                        "cpm",
                        "leads",
                        "cpl",
                      ] as SortKey[]
                    ).map((key) => (
                      <SortableTh
                        key={key}
                        label={SORT_LABELS[key]}
                        active={sortKey === key}
                        dir={sortDir}
                        onClick={() => handleSort(key)}
                        alignRight
                      />
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredRows.map((row) =>
                    row.rowType === "rollup" ? (
                      <RollupGroup
                        key={`rollup-${row.id}`}
                        row={row}
                        isExpanded={expandedRollups.has(row.id)}
                        onToggle={() => toggleRollup(row.id)}
                      />
                    ) : (
                      <MetaAdTableRow key={row.rowKey} row={row} />
                    )
                  )}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={13}
                        className="px-4 py-8 text-center text-sm text-slate-400"
                      >
                        No ads match this search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        {label}
      </label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-white">
        {value}
      </div>
    </div>
  );
}

function RollupPhraseChips({
  phrases,
  disabled,
  onToggle,
  onDelete,
}: {
  phrases: MetaAdsPhrase[];
  disabled: boolean;
  onToggle: (phrase: MetaAdsPhrase) => void;
  onDelete: (phrase: MetaAdsPhrase) => void;
}) {
  if (phrases.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/30 p-4 text-sm text-slate-400">
        No rollup phrases yet. Add a phrase like{" "}
        <span className="text-slate-200">shoulderimage</span> or{" "}
        <span className="text-slate-200">xray</span>; enabled phrases appear as
        rollup rows in the table.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-slate-900/30 p-3">
      {phrases.map((phrase) => (
        <span
          key={phrase.id}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
            phrase.enabled
              ? "border-indigo-400/30 bg-indigo-500/15 text-indigo-100"
              : "border-white/10 bg-slate-800/50 text-slate-400"
          }`}
        >
          <span>{phrase.phrase}</span>
          <button
            type="button"
            onClick={() => onToggle(phrase)}
            disabled={disabled}
            className="rounded px-1 text-[10px] uppercase tracking-wide hover:bg-white/10 disabled:opacity-50"
          >
            {phrase.enabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(phrase)}
            disabled={disabled}
            className="rounded px-1 text-[10px] uppercase tracking-wide text-red-200 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </span>
      ))}
    </div>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  alignRight,
  sticky,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  alignRight?: boolean;
  sticky?: boolean;
}) {
  return (
    <th
      className={`${sticky ? "sticky left-0 z-30 shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]" : "sticky z-20"} top-0 cursor-pointer border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold hover:text-white ${
        alignRight ? "text-right" : "text-left"
      }`}
      onClick={onClick}
    >
      <span
        className={`inline-flex items-center gap-1 ${
          alignRight ? "justify-end" : ""
        }`}
      >
        {label}
        {active && <span className="text-[10px]">{dir === "desc" ? "v" : "^"}</span>}
      </span>
    </th>
  );
}

function RollupGroup({
  row,
  isExpanded,
  onToggle,
}: {
  row: MetaAdsRollup & {
    rowType: "rollup";
    children: Array<MetaAdsRow & { matchingRollups: MetaAdsRollup[] }>;
  };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <RollupTableRow row={row} isExpanded={isExpanded} onToggle={onToggle} />
      {isExpanded &&
        row.children.map((child) => (
          <MetaAdTableRow key={`${row.id}-${child.rowKey}`} row={child} nested />
        ))}
    </>
  );
}

function RollupTableRow({
  row,
  isExpanded,
  onToggle,
}: {
  row: MetaAdsRollup & {
    rowType: "rollup";
    children: Array<MetaAdsRow & { matchingRollups: MetaAdsRollup[] }>;
  };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="bg-indigo-500/10 hover:bg-indigo-500/15">
      <td className="sticky left-0 z-10 min-w-[340px] bg-slate-950/95 px-3 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-indigo-200 transition-colors hover:bg-indigo-500/20 hover:text-white"
            aria-label={isExpanded ? "Collapse rollup" : "Expand rollup"}
          >
            <span
              className={`text-[10px] transition-transform ${
                isExpanded ? "rotate-90" : ""
              }`}
            >
              &gt;
            </span>
          </button>
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-indigo-400/30 bg-indigo-500/15 text-[10px] font-semibold uppercase tracking-wide text-indigo-100">
            Rollup
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-semibold text-indigo-100">
                {row.phrase}
              </div>
              <span className="rounded bg-indigo-500/20 px-1.5 py-px text-[10px] uppercase tracking-wide text-indigo-100">
                Combined
              </span>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {formatCount(row.children.length)} matching ads
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-slate-200">
        <div className="font-medium">Rollup</div>
        <div className="text-[11px] text-slate-500">Enabled phrase</div>
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        Contains &quot;{row.phrase}&quot;
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        Combined ad sets
      </td>
      <MetricTd value={formatMoney(row.spend)} />
      <MetricTd value={formatCount(row.impressions)} />
      <MetricTd value={formatCount(row.reach)} />
      <MetricTd value={formatCount(row.inlineLinkClicks)} />
      <MetricTd value={formatPercent(row.ctr)} />
      <MetricTd value={formatMoneyDecimal(row.cpc)} />
      <MetricTd value={formatMoneyDecimal(row.cpm)} />
      <MetricTd value={formatCount(row.leads)} />
      <MetricTd value={formatMoneyDecimal(row.cpl)} />
    </tr>
  );
}

function MetaAdTableRow({
  row,
  nested,
}: {
  row: MetaAdsRow & { matchingRollups: MetaAdsRollup[] };
  nested?: boolean;
}) {
  return (
    <tr className={nested ? "bg-slate-950/35 hover:bg-white/5" : "hover:bg-white/5"}>
      <td
        className={`sticky left-0 z-10 min-w-[340px] bg-slate-950/80 px-3 py-3 ${
          nested ? "pl-14" : ""
        }`}
      >
        <div className="flex items-center gap-3">
          <CreativeThumb url={row.thumbnailUrl} adName={row.adName} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-medium text-slate-100">{row.adName}</div>
              {row.adsManagerUrl && (
                <a
                  href={row.adsManagerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded border border-white/10 bg-slate-800/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300 transition-colors hover:border-indigo-400/50 hover:text-indigo-200"
                  title="Open ad in Meta Ads Manager"
                >
                  Open
                </a>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
              <span>{row.adId}</span>
              {row.matchingRollups.map((rollup) => (
                <span
                  key={rollup.id}
                  className="rounded bg-indigo-500/15 px-1.5 py-px text-indigo-200"
                  title={`Included in ${rollup.phrase} rollup`}
                >
                  in {rollup.phrase}
                </span>
              ))}
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-slate-200">
        <div className="font-medium">{row.businessName}</div>
        <div className="text-[11px] text-slate-500">
          {row.status}
          {row.cid ? ` - CID ${row.cid}` : ""}
        </div>
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        <div className="line-clamp-2">{row.campaignName ?? "Campaign"}</div>
        {row.campaignKeyword && (
          <div className="mt-1 text-[11px] text-slate-500">
            Filter: {row.campaignKeyword}
          </div>
        )}
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        <div className="line-clamp-2">{row.adsetName ?? "Ad set"}</div>
      </td>
      <MetricTd value={formatMoney(row.spend)} />
      <MetricTd value={formatCount(row.impressions)} />
      <MetricTd value={formatCount(row.reach)} />
      <MetricTd value={formatCount(row.inlineLinkClicks)} />
      <MetricTd value={formatPercent(row.ctr)} />
      <MetricTd value={formatMoneyDecimal(row.cpc)} />
      <MetricTd value={formatMoneyDecimal(row.cpm)} />
      <MetricTd value={formatCount(row.leads)} />
      <MetricTd value={formatMoneyDecimal(row.cpl)} />
    </tr>
  );
}

function CreativeThumb({ url, adName }: { url: string | null; adName: string }) {
  if (!url) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-slate-800 text-[10px] uppercase tracking-wide text-slate-500">
        No img
      </div>
    );
  }
  return (
    <div
      aria-label={`Thumbnail for ${adName}`}
      className="h-14 w-14 shrink-0 rounded-lg border border-white/10 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: `url("${url}")` }}
    />
  );
}

function MetricTd({ value }: { value: string }) {
  return (
    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-200">
      {value}
    </td>
  );
}

function adMatchesQuery(row: MetaAdsRow, query: string): boolean {
  return [
    row.businessName,
    row.ownerName,
    row.adName,
    row.adsetName,
    row.campaignName,
    row.cid,
    row.campaignKeyword,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function compareRows(
  a: AdsTableRow,
  b: AdsTableRow,
  key: SortKey,
  dir: "asc" | "desc"
): number {
  const av = getSortValue(a, key);
  const bv = getSortValue(b, key);
  let result = 0;
  if (typeof av === "string" || typeof bv === "string") {
    result = String(av ?? "").localeCompare(String(bv ?? ""));
  } else {
    const an = av ?? Number.NEGATIVE_INFINITY;
    const bn = bv ?? Number.NEGATIVE_INFINITY;
    result = an === bn ? 0 : an > bn ? 1 : -1;
  }
  return dir === "desc" ? result * -1 : result;
}

function getSortValue(row: AdsTableRow, key: SortKey): string | number | null {
  switch (key) {
    case "adName":
      return row.rowType === "rollup" ? row.phrase : row.adName;
    case "businessName":
      return row.rowType === "rollup" ? "Rollup" : row.businessName;
    case "campaignName":
      return row.rowType === "rollup" ? row.phrase : row.campaignName;
    default:
      return row[key];
  }
}
