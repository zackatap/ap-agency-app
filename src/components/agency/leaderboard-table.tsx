"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  ClientCampaignSummary,
  ClientLeaderboardRow,
  MetricKey,
} from "./types";
import { METRIC_META, METRIC_ORDER } from "./metric-meta";
import { formatMetricValue } from "./format";
import {
  buildLeaderboardRows,
  getCampaignMetric,
  getRowMetric,
} from "./benchmarks";

interface Props {
  campaigns: ClientCampaignSummary[];
  monthKey: string | "total";
  defaultSort?: MetricKey;
  /**
   * Campaign keys flagged by the data-hygiene filter. Rows that match get
   * grayed out with a "Data stale" badge; CID groups whose children are
   * ALL flagged are fully grayed, mixed groups show a partial hint.
   */
  excludedKeys?: ReadonlySet<string>;
}

type ViewMode = "cid" | "campaign";

/**
 * Sortable leaderboard. In "cid" mode, campaigns sharing a CID are rolled up
 * into a single row with an accordion arrow that expands to show each
 * campaign separately. "campaign" mode is flat.
 */
export function LeaderboardTable({
  campaigns,
  monthKey,
  defaultSort = "closed",
  excludedKeys,
}: Props) {
  const [mode, setMode] = useState<ViewMode>("cid");
  const [sortKey, setSortKey] = useState<MetricKey>(defaultSort);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => buildLeaderboardRows(campaigns, mode),
    [campaigns, mode]
  );

  /**
   * A row counts as "stale" when every campaign it represents (just itself
   * for a leaf row; all children for a CID rollup) is in the excluded set.
   * Mixed rows stay fully-colored but surface a subtle hint in the expand.
   */
  const rowStaleness = useMemo(() => {
    const map = new Map<string, "all" | "some" | "none">();
    if (!excludedKeys || excludedKeys.size === 0) return map;
    for (const row of rows) {
      let flagged = 0;
      for (const child of row.children) {
        if (excludedKeys.has(child.campaignKey)) flagged += 1;
      }
      map.set(
        row.rowKey,
        flagged === 0
          ? "none"
          : flagged === row.children.length
            ? "all"
            : "some"
      );
    }
    return map;
  }, [rows, excludedKeys]);

  const sorted = useMemo(() => {
    const meta = METRIC_META[sortKey];
    const effectiveDir =
      sortDir === "desc" ? (meta.higherIsBetter ? "desc" : "asc") : sortDir;
    const arr = rows.slice();
    arr.sort((a, b) => {
      const av = getRowMetric(a, sortKey, monthKey);
      const bv = getRowMetric(b, sortKey, monthKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return effectiveDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [rows, sortKey, sortDir, monthKey]);

  function handleSort(key: MetricKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function toggleRow(rowKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg bg-slate-800/50 p-1 text-xs self-start">
        <button
          type="button"
          onClick={() => setMode("cid")}
          className={`rounded-md px-3 py-1 ${
            mode === "cid"
              ? "bg-indigo-600 text-white"
              : "text-slate-300 hover:text-white"
          }`}
        >
          By client (CID)
        </button>
        <button
          type="button"
          onClick={() => setMode("campaign")}
          className={`rounded-md px-3 py-1 ${
            mode === "campaign"
              ? "bg-indigo-600 text-white"
              : "text-slate-300 hover:text-white"
          }`}
        >
          By campaign
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900/30">
        <table className="min-w-full divide-y divide-white/5 text-sm">
          <thead>
            <tr className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="sticky left-0 z-10 bg-slate-900/60 px-4 py-3 font-semibold">
                Client
              </th>
              {METRIC_ORDER.map((key) => (
                <th
                  key={key}
                  className="cursor-pointer px-3 py-3 text-right font-semibold hover:text-white"
                  onClick={() => handleSort(key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {METRIC_META[key].label}
                    {sortKey === key && (
                      <span className="text-[10px]">
                        {sortDir === "desc" ? "▼" : "▲"}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sorted.map((row) => (
              <RowGroup
                key={row.rowKey}
                row={row}
                monthKey={monthKey}
                isExpanded={expanded.has(row.rowKey)}
                onToggle={() => toggleRow(row.rowKey)}
                staleness={rowStaleness.get(row.rowKey) ?? "none"}
                excludedKeys={excludedKeys}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowGroupProps {
  row: ClientLeaderboardRow;
  monthKey: string | "total";
  isExpanded: boolean;
  onToggle: () => void;
  staleness: "all" | "some" | "none";
  excludedKeys?: ReadonlySet<string>;
}

function RowGroup({
  row,
  monthKey,
  isExpanded,
  onToggle,
  staleness,
  excludedKeys,
}: RowGroupProps) {
  const showChildren = row.isGroup && isExpanded && row.children.length > 1;
  const rowOpacity =
    staleness === "all"
      ? "opacity-50"
      : staleness === "some"
        ? "opacity-90"
        : "";
  return (
    <>
      <tr className={`hover:bg-white/5 ${rowOpacity}`}>
        <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2">
          <div className="flex items-center gap-2">
            {row.isGroup && row.children.length > 1 ? (
              <button
                type="button"
                onClick={onToggle}
                className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white"
                aria-label={isExpanded ? "Collapse" : "Expand"}
              >
                <span
                  className={`text-[10px] transition-transform ${
                    isExpanded ? "rotate-90" : ""
                  }`}
                >
                  ▶
                </span>
              </button>
            ) : (
              <span className="w-5" aria-hidden />
            )}
            <ClientLink row={row} staleness={staleness} />
          </div>
        </td>
        {METRIC_ORDER.map((key) => {
          const meta = METRIC_META[key];
          const val = getRowMetric(row, key, monthKey);
          return (
            <td
              key={key}
              className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-200"
            >
              {formatMetricValue(val, meta.kind)}
            </td>
          );
        })}
      </tr>
      {showChildren &&
        row.children.map((child) => {
          const childStale = excludedKeys?.has(child.campaignKey) ?? false;
          return (
            <tr
              key={child.campaignKey}
              className={`bg-slate-950/40 hover:bg-white/5 ${
                childStale ? "opacity-50" : ""
              }`}
            >
              <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2 pl-12">
                <Link
                  href={`/agency/dashboard/${child.locationId}?campaign=${encodeURIComponent(child.campaignKey)}`}
                  className="flex flex-col text-slate-300 hover:text-indigo-300"
                >
                  <span className="text-[13px]">
                    <StatusBadge status={child.status} />{" "}
                    {child.pipelineName ?? child.pipelineKeyword ?? "Pipeline"}
                    {childStale && <StaleBadge />}
                  </span>
                  {!child.included && (
                    <span className="text-[11px] text-amber-400">
                      {child.errorMessage ?? child.needsSetupReason ?? "Needs setup"}
                    </span>
                  )}
                </Link>
              </td>
              {METRIC_ORDER.map((key) => {
                const meta = METRIC_META[key];
                const val = getCampaignMetric(child, key, monthKey);
                return (
                  <td
                    key={key}
                    className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-300"
                  >
                    {formatMetricValue(val, meta.kind)}
                  </td>
                );
              })}
            </tr>
          );
        })}
    </>
  );
}

function ClientLink({
  row,
  staleness,
}: {
  row: ClientLeaderboardRow;
  staleness: "all" | "some" | "none";
}) {
  const href = row.locationId
    ? `/agency/dashboard/${row.locationId}${
        row.campaignKey ? `?campaign=${encodeURIComponent(row.campaignKey)}` : ""
      }`
    : null;
  const content = (
    <>
      <span className="font-medium text-slate-100">{row.displayName}</span>
      {row.subLabel && (
        <span className="text-[11px] text-slate-500">{row.subLabel}</span>
      )}
      <span className="mt-0.5 flex items-center gap-1">
        {row.statuses.map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
        {staleness === "all" && <StaleBadge />}
        {staleness === "some" && <StaleBadge partial />}
      </span>
      {!row.included && (
        <span className="text-[11px] text-amber-400">
          {row.errorMessage ?? "Not included"}
        </span>
      )}
    </>
  );
  if (!href) {
    return <div className="flex flex-col">{content}</div>;
  }
  return (
    <Link href={href} className="flex flex-col hover:text-indigo-300">
      {content}
    </Link>
  );
}

function StaleBadge({ partial }: { partial?: boolean } = {}) {
  return (
    <span
      className="inline-block rounded bg-slate-700/60 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-300"
      title={
        partial
          ? "Some campaigns in this client haven't been updating their opportunity board — excluded from averages."
          : "Opportunity board hasn't been kept up to date — excluded from rate averages."
      }
    >
      {partial ? "Partial stale" : "Data stale"}
    </span>
  );
}

function StatusBadge({ status }: { status: "ACTIVE" | "2ND CMPN" }) {
  const isPrimary = status === "ACTIVE";
  return (
    <span
      className={`inline-block rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
        isPrimary
          ? "bg-emerald-500/20 text-emerald-300"
          : "bg-amber-500/20 text-amber-300"
      }`}
    >
      {status}
    </span>
  );
}
