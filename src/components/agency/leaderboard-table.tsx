"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * Total columns rendered by the table: 1 "Client" column + one per metric.
 * Used for the inline "Compare" expansion's colSpan.
 */
const TOTAL_COLUMNS = METRIC_ORDER.length + 1;

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
  /**
   * Controlled: which campaign's inline benchmark is currently expanded.
   * `null` means none. When provided alongside `renderCompare`, each
   * comparable row gets a "Compare" button that expands an inline row
   * immediately below with the provided node.
   */
  compareCampaignKey?: string | null;
  onCompareCampaignKeyChange?: (key: string | null) => void;
  renderCompare?: (campaign: ClientCampaignSummary) => React.ReactNode;
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
  compareCampaignKey,
  onCompareCampaignKeyChange,
  renderCompare,
}: Props) {
  const [mode, setMode] = useState<ViewMode>("cid");
  const [sortKey, setSortKey] = useState<MetricKey>(defaultSort);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tableRef = useRef<HTMLDivElement | null>(null);
  /**
   * Width of the *visible* scroll viewport (not the inner table width).
   * The inline Compare expansion is rendered inside a `<td colSpan>`, so
   * without constraint it would stretch to the full table width — which
   * is much wider than the dashboard container because of all the metric
   * columns — and the benchmark charts would be clipped off-screen to
   * the right. We measure the scroll container and pin the expansion
   * content to `offsetWidth` with `position: sticky; left: 0`.
   */
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const update = () => setViewportWidth(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const rows = useMemo(
    () => buildLeaderboardRows(campaigns, mode),
    [campaigns, mode]
  );

  /**
   * If compare-expanding a child of a multi-campaign group, auto-open its
   * parent accordion so the inline benchmark appears directly under it.
   */
  useEffect(() => {
    if (!compareCampaignKey) return;
    const parent = rows.find(
      (r) =>
        r.isGroup &&
        r.children.length > 1 &&
        r.children.some((c) => c.campaignKey === compareCampaignKey)
    );
    if (parent) {
      setExpanded((prev) => {
        if (prev.has(parent.rowKey)) return prev;
        const next = new Set(prev);
        next.add(parent.rowKey);
        return next;
      });
    }
  }, [compareCampaignKey, rows]);

  /**
   * When a row's Compare expansion opens, scroll it into view so the
   * benchmark block is actually visible (especially when triggered from
   * the distribution strip above).
   */
  useEffect(() => {
    if (!compareCampaignKey) return;
    const el = tableRef.current?.querySelector<HTMLElement>(
      `[data-compare-anchor="${CSS.escape(compareCampaignKey)}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [compareCampaignKey]);

  const canCompare = typeof renderCompare === "function";

  function toggleCompare(campaignKey: string) {
    if (!onCompareCampaignKeyChange) return;
    onCompareCampaignKeyChange(
      compareCampaignKey === campaignKey ? null : campaignKey
    );
  }

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

      <div
        ref={tableRef}
        className="overflow-x-auto rounded-xl border border-white/10 bg-slate-900/30"
      >
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
                canCompare={canCompare}
                compareCampaignKey={compareCampaignKey ?? null}
                onCompareToggle={toggleCompare}
                renderCompare={renderCompare}
                campaigns={campaigns}
                viewportWidth={viewportWidth}
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
  canCompare: boolean;
  compareCampaignKey: string | null;
  onCompareToggle: (campaignKey: string) => void;
  renderCompare?: (campaign: ClientCampaignSummary) => React.ReactNode;
  campaigns: ClientCampaignSummary[];
  viewportWidth: number | null;
}

function RowGroup({
  row,
  monthKey,
  isExpanded,
  onToggle,
  staleness,
  excludedKeys,
  canCompare,
  compareCampaignKey,
  onCompareToggle,
  renderCompare,
  campaigns,
  viewportWidth,
}: RowGroupProps) {
  const showChildren = row.isGroup && isExpanded && row.children.length > 1;
  const rowOpacity =
    staleness === "all"
      ? "opacity-50"
      : staleness === "some"
        ? "opacity-90"
        : "";

  /**
   * A row is a single-campaign leaf when either we're in campaign mode or
   * it's a CID group that collapsed to one campaign. Those rows get a
   * Compare button directly. Multi-campaign groups don't get one (their
   * rollup isn't a comparable entity); instead the child rows each get one.
   */
  const singleCampaign: ClientCampaignSummary | null =
    row.children.length === 1
      ? findCampaign(campaigns, row.children[0].campaignKey)
      : null;
  const rowCompareKey = singleCampaign?.campaignKey ?? null;
  const isRowCompared =
    rowCompareKey != null && compareCampaignKey === rowCompareKey;

  return (
    <>
      <tr
        className={`hover:bg-white/5 ${rowOpacity} ${
          isRowCompared ? "bg-indigo-500/10" : ""
        }`}
        data-compare-anchor={rowCompareKey ?? undefined}
      >
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
            {canCompare && singleCampaign && (
              <CompareButton
                active={isRowCompared}
                onClick={() => onCompareToggle(singleCampaign.campaignKey)}
              />
            )}
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
      {isRowCompared && singleCampaign && renderCompare && (
        <CompareRow
          onClose={() => onCompareToggle(singleCampaign.campaignKey)}
          viewportWidth={viewportWidth}
        >
          {renderCompare(singleCampaign)}
        </CompareRow>
      )}
      {showChildren &&
        row.children.map((child) => {
          const childStale = excludedKeys?.has(child.campaignKey) ?? false;
          const childCampaign = findCampaign(campaigns, child.campaignKey);
          const isChildCompared = compareCampaignKey === child.campaignKey;
          return (
            <React.Fragment key={child.campaignKey}>
              <tr
                className={`bg-slate-950/40 hover:bg-white/5 ${
                  childStale ? "opacity-50" : ""
                } ${isChildCompared ? "bg-indigo-500/10" : ""}`}
                data-compare-anchor={child.campaignKey}
              >
                <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2 pl-12">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/agency/dashboard/${child.locationId}?campaign=${encodeURIComponent(child.campaignKey)}`}
                      className="flex flex-col text-slate-300 hover:text-indigo-300"
                    >
                      <span className="text-[13px]">
                        <StatusBadge status={child.status} />{" "}
                        {child.pipelineName ??
                          child.pipelineKeyword ??
                          "Pipeline"}
                        {childStale && <StaleBadge />}
                      </span>
                      {!child.included && (
                        <span className="text-[11px] text-amber-400">
                          {child.errorMessage ??
                            child.needsSetupReason ??
                            "Needs setup"}
                        </span>
                      )}
                    </Link>
                    {canCompare && childCampaign && (
                      <CompareButton
                        active={isChildCompared}
                        onClick={() => onCompareToggle(child.campaignKey)}
                      />
                    )}
                  </div>
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
              {isChildCompared && childCampaign && renderCompare && (
                <CompareRow
                  onClose={() => onCompareToggle(child.campaignKey)}
                  viewportWidth={viewportWidth}
                >
                  {renderCompare(childCampaign)}
                </CompareRow>
              )}
            </React.Fragment>
          );
        })}
    </>
  );
}

function findCampaign(
  campaigns: ClientCampaignSummary[],
  campaignKey: string
): ClientCampaignSummary | null {
  return campaigns.find((c) => c.campaignKey === campaignKey) ?? null;
}

function CompareButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ml-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "border-indigo-400 bg-indigo-500/20 text-indigo-100"
          : "border-white/10 bg-slate-800/60 text-slate-400 hover:border-indigo-400/40 hover:text-indigo-200"
      }`}
      title={active ? "Hide benchmark" : "Compare vs. agency"}
    >
      {active ? "Hide" : "Compare"}
    </button>
  );
}

function CompareRow({
  children,
  onClose,
  viewportWidth,
}: {
  children: React.ReactNode;
  onClose: () => void;
  viewportWidth: number | null;
}) {
  /*
   * The `<td colSpan>` stretches to the full table width (which scrolls
   * horizontally because of all the metric columns). We pin the actual
   * content to the *visible* scroll-container width with
   * `position: sticky; left: 0` so the benchmark charts render inside
   * the dashboard viewport instead of getting clipped off-screen to
   * the right.
   */
  return (
    <tr className="bg-slate-950/60">
      <td colSpan={TOTAL_COLUMNS} className="p-0">
        <div
          className="sticky left-0 border-y border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-slate-900/60"
          style={
            viewportWidth
              ? { width: `${viewportWidth}px`, maxWidth: "100%" }
              : undefined
          }
        >
          <div className="relative p-5">
            <button
              type="button"
              onClick={onClose}
              className="absolute right-4 top-4 z-10 rounded-md border border-white/10 bg-slate-800/60 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-700/60 hover:text-white"
            >
              Close
            </button>
            {children}
          </div>
        </div>
      </td>
    </tr>
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
