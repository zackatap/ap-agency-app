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
  getCampaignLabel,
  getRowMetric,
} from "./benchmarks";

/**
 * Total columns rendered by the table: "Client" + "Campaign" + metrics.
 * Used for the inline "Compare" expansion's colSpan.
 */
const TOTAL_COLUMNS = METRIC_ORDER.length + 2;

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
type FilterField = "client" | "campaign" | MetricKey;
type FilterOperator = "contains" | "gt" | "lt";

interface LeaderboardFilter {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

const FILTER_FIELDS: Array<{
  key: FilterField;
  label: string;
  type: "text" | "number";
}> = [
  { key: "client", label: "Client", type: "text" },
  { key: "campaign", label: "Campaign", type: "text" },
  ...METRIC_ORDER.map((key) => ({
    key,
    label: METRIC_META[key].label,
    type: "number" as const,
  })),
];

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
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<LeaderboardFilter[]>([]);
  const [draftField, setDraftField] = useState<FilterField>("leads");
  const [draftOperator, setDraftOperator] = useState<FilterOperator>("gt");
  const [draftValue, setDraftValue] = useState("");
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

  const compareParentRowKey = useMemo(() => {
    if (!compareCampaignKey) return;
    const parent = rows.find(
      (r) =>
        r.isGroup &&
        r.children.length > 1 &&
        r.children.some((c) => c.campaignKey === compareCampaignKey)
    );
    return parent?.rowKey;
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

  const filteredRows = useMemo(
    () =>
      filters.length === 0
        ? rows
        : rows.filter((row) =>
            filters.every((filter) => rowMatchesFilter(row, filter, monthKey))
          ),
    [rows, filters, monthKey]
  );

  const canCompare = typeof renderCompare === "function";
  const selectedItems = useMemo(
    () => buildSelectedItems(filteredRows, selectedKeys),
    [filteredRows, selectedKeys]
  );

  function toggleCompare(campaignKey: string) {
    if (!onCompareCampaignKeyChange) return;
    onCompareCampaignKeyChange(
      compareCampaignKey === campaignKey ? null : campaignKey
    );
  }

  function toggleSelection(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
    const arr = filteredRows.slice();
    arr.sort((a, b) => {
      const av = getRowMetric(a, sortKey, monthKey);
      const bv = getRowMetric(b, sortKey, monthKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [filteredRows, sortKey, sortDir, monthKey]);

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

  function handleDraftFieldChange(value: FilterField) {
    setDraftField(value);
    setDraftOperator(getFilterFieldType(value) === "text" ? "contains" : "gt");
    setDraftValue("");
  }

  function addFilter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draftValue.trim();
    if (!value) return;

    const fieldType = getFilterFieldType(draftField);
    const normalizedValue =
      fieldType === "number" ? normalizeNumericFilterValue(value) : value;
    if (fieldType === "number" && normalizedValue == null) return;

    setFilters((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${draftField}-${prev.length}`,
        field: draftField,
        operator: fieldType === "text" ? "contains" : draftOperator,
        value: normalizedValue ?? value,
      },
    ]);
    setDraftValue("");
  }

  function removeFilter(id: string) {
    setFilters((prev) => prev.filter((filter) => filter.id !== id));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <FilterBuilder
            field={draftField}
            operator={draftOperator}
            value={draftValue}
            onFieldChange={handleDraftFieldChange}
            onOperatorChange={setDraftOperator}
            onValueChange={setDraftValue}
            onSubmit={addFilter}
          />
          {selectedItems.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedKeys(new Set())}
              className="rounded-md border border-white/10 bg-slate-800/60 px-3 py-1 text-xs text-slate-300 hover:border-indigo-400/40 hover:text-white"
            >
              Clear {selectedItems.length} selected
            </button>
          )}
        </div>
      </div>

      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>
            Showing {filteredRows.length} of {rows.length}
          </span>
          {filters.map((filter) => (
            <FilterChip
              key={filter.id}
              filter={filter}
              onRemove={() => removeFilter(filter.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => setFilters([])}
            className="rounded-full border border-white/10 px-2 py-1 text-slate-400 hover:border-indigo-400/40 hover:text-white"
          >
            Clear filters
          </button>
        </div>
      )}

      <div
        ref={tableRef}
        className="max-w-full overflow-x-auto rounded-xl border border-white/10 bg-slate-900/30"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 divide-y divide-white/5 text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="sticky left-0 top-0 z-30 border-b border-white/10 bg-slate-900 px-4 py-3 text-left font-semibold shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]">
                Client
              </th>
              <th className="sticky top-0 z-20 border-b border-white/10 bg-slate-900 px-3 py-3 text-left font-semibold shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)]">
                Campaign
              </th>
              {METRIC_ORDER.map((key) => (
                <th
                  key={key}
                  className="sticky top-0 z-20 cursor-pointer border-b border-white/10 bg-slate-900 px-3 py-3 text-right font-semibold shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5)] hover:text-white"
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
            {selectedItems.length > 0 && (
              <SelectedSummaryRow
                items={selectedItems}
                monthKey={monthKey}
              />
            )}
            {sorted.map((row) => (
              <RowGroup
                key={row.rowKey}
                row={row}
                monthKey={monthKey}
                isExpanded={
                  expanded.has(row.rowKey) || compareParentRowKey === row.rowKey
                }
                onToggle={() => toggleRow(row.rowKey)}
                staleness={rowStaleness.get(row.rowKey) ?? "none"}
                excludedKeys={excludedKeys}
                canCompare={canCompare}
                compareCampaignKey={compareCampaignKey ?? null}
                onCompareToggle={toggleCompare}
                renderCompare={renderCompare}
                campaigns={campaigns}
                viewportWidth={viewportWidth}
                selectedKeys={selectedKeys}
                onSelectionToggle={toggleSelection}
              />
            ))}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={TOTAL_COLUMNS}
                  className="px-4 py-8 text-center text-sm text-slate-400"
                >
                  No clients match the current filters.
                </td>
              </tr>
            )}
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
  selectedKeys: ReadonlySet<string>;
  onSelectionToggle: (key: string) => void;
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
  selectedKeys,
  onSelectionToggle,
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
  const isSelected = selectedKeys.has(row.rowKey);

  return (
    <>
      <tr
        className={`hover:bg-white/5 ${rowOpacity} ${
          isRowCompared ? "bg-indigo-500/10" : ""
        } ${isSelected ? "bg-indigo-500/5" : ""}`}
        data-compare-anchor={rowCompareKey ?? undefined}
      >
        <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2">
          <div className="flex items-center gap-2">
            <SelectionCheckbox
              checked={isSelected}
              label={`Select ${row.displayName}`}
              onChange={() => onSelectionToggle(row.rowKey)}
            />
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
        <td className="whitespace-nowrap px-3 py-2 text-left text-slate-300">
          {row.campaignLabel ?? <span className="text-slate-600">—</span>}
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
          const childSelectionKey = campaignSelectionKey(child);
          const isChildSelected = selectedKeys.has(childSelectionKey);
          return (
            <React.Fragment key={child.campaignKey}>
              <tr
                className={`bg-slate-950/40 hover:bg-white/5 ${
                  childStale ? "opacity-50" : ""
                } ${isChildCompared ? "bg-indigo-500/10" : ""} ${
                  isChildSelected ? "bg-indigo-500/5" : ""
                }`}
                data-compare-anchor={child.campaignKey}
              >
                <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2 pl-12">
                  <div className="flex items-center gap-2">
                    <SelectionCheckbox
                      checked={isChildSelected}
                      label={`Select ${child.businessName}`}
                      onChange={() => onSelectionToggle(childSelectionKey)}
                    />
                    <Link
                      href={`/agency/dashboard/${child.locationId}?campaign=${encodeURIComponent(child.campaignKey)}`}
                      className="flex flex-col text-slate-300 hover:text-indigo-300"
                    >
                      <span className="text-[13px]">
                        <StatusBadge status={child.status} />{" "}
                        {getCampaignLabel(child) ?? "Campaign"}
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
                <td className="whitespace-nowrap px-3 py-2 text-left text-slate-300">
                  {getCampaignLabel(child) ?? (
                    <span className="text-slate-600">—</span>
                  )}
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

function FilterBuilder({
  field,
  operator,
  value,
  onFieldChange,
  onOperatorChange,
  onValueChange,
  onSubmit,
}: {
  field: FilterField;
  operator: FilterOperator;
  value: string;
  onFieldChange: (field: FilterField) => void;
  onOperatorChange: (operator: FilterOperator) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const fieldType = getFilterFieldType(field);

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/50 p-1 text-xs"
    >
      <select
        value={field}
        onChange={(event) => onFieldChange(event.target.value as FilterField)}
        className="rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-slate-200 outline-none hover:border-indigo-400/40"
        aria-label="Filter column"
      >
        {FILTER_FIELDS.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>

      {fieldType === "number" ? (
        <select
          value={operator}
          onChange={(event) =>
            onOperatorChange(event.target.value as FilterOperator)
          }
          className="rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-slate-200 outline-none hover:border-indigo-400/40"
          aria-label="Filter operator"
        >
          <option value="gt">&gt;</option>
          <option value="lt">&lt;</option>
        </select>
      ) : (
        <span className="rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-slate-300">
          contains
        </span>
      )}

      <input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        inputMode={fieldType === "number" ? "decimal" : "text"}
        placeholder={fieldType === "number" ? "30" : "Pain"}
        className="w-24 rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-slate-100 outline-none placeholder:text-slate-600 hover:border-indigo-400/40 focus:border-indigo-400/60"
        aria-label="Filter value"
      />

      <button
        type="submit"
        disabled={!value.trim()}
        className="rounded-md bg-indigo-600 px-2 py-1 font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        Add
      </button>
    </form>
  );
}

function FilterChip({
  filter,
  onRemove,
}: {
  filter: LeaderboardFilter;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2 py-1 text-indigo-100">
      <span>
        {getFilterFieldLabel(filter.field)} {formatFilterOperator(filter)}{" "}
        {filter.operator === "contains" ? `"${filter.value}"` : filter.value}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full px-1 text-indigo-200 hover:bg-white/10 hover:text-white"
        aria-label={`Remove ${getFilterFieldLabel(filter.field)} filter`}
      >
        x
      </button>
    </span>
  );
}

function getFilterFieldType(field: FilterField): "text" | "number" {
  return field === "client" || field === "campaign" ? "text" : "number";
}

function getFilterFieldLabel(field: FilterField): string {
  if (field === "client") return "Client";
  if (field === "campaign") return "Campaign";
  return METRIC_META[field].label;
}

function formatFilterOperator(filter: LeaderboardFilter): string {
  if (filter.operator === "contains") return "contains";
  return filter.operator === "gt" ? ">" : "<";
}

function normalizeNumericFilterValue(value: string): string | null {
  const parsed = Number(value.replace(/[$,%\sx]/gi, ""));
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function rowMatchesFilter(
  row: ClientLeaderboardRow,
  filter: LeaderboardFilter,
  monthKey: string | "total"
): boolean {
  if (filter.field === "client" || filter.field === "campaign") {
    const haystack = getTextFilterValue(row, filter.field).toLowerCase();
    return haystack.includes(filter.value.toLowerCase());
  }

  const target = getRowMetric(row, filter.field, monthKey);
  const threshold = Number(filter.value);
  if (target == null || !Number.isFinite(threshold)) return false;

  return filter.operator === "lt" ? target < threshold : target > threshold;
}

function getTextFilterValue(
  row: ClientLeaderboardRow,
  field: "client" | "campaign"
): string {
  if (field === "client") {
    return [
      row.displayName,
      row.subLabel,
      row.cid,
      ...row.children.flatMap((child) => [
        child.businessName,
        child.ownerName,
        child.cid,
      ]),
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    row.campaignLabel,
    row.pipelineName,
    ...row.children.flatMap((child) => [
      getCampaignLabel(child),
      child.pipelineName,
      child.pipelineKeyword,
      child.campaignKeyword,
      child.packageEnrolled,
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

type SelectedItem =
  | { key: string; type: "row"; row: ClientLeaderboardRow }
  | { key: string; type: "campaign"; campaign: ClientCampaignSummary };

const TOTAL_METRICS = new Set<MetricKey>([
  "leads",
  "totalAppts",
  "showed",
  "closed",
  "totalValue",
  "successValue",
  "adSpend",
]);

function campaignSelectionKey(campaign: Pick<ClientCampaignSummary, "campaignKey">): string {
  return `cmp:${campaign.campaignKey}`;
}

function buildSelectedItems(
  rows: ClientLeaderboardRow[],
  selectedKeys: ReadonlySet<string>
): SelectedItem[] {
  const items: SelectedItem[] = [];
  for (const row of rows) {
    if (selectedKeys.has(row.rowKey)) {
      items.push({ key: row.rowKey, type: "row", row });
    }
    if (!row.isGroup) continue;
    for (const campaign of row.children) {
      const key = campaignSelectionKey(campaign);
      if (selectedKeys.has(key)) {
        items.push({ key, type: "campaign", campaign });
      }
    }
  }
  return items;
}

function getSelectedMetric(
  items: SelectedItem[],
  metric: MetricKey,
  monthKey: string | "total"
): number | null {
  const values = items
    .map((item) =>
      item.type === "row"
        ? getRowMetric(item.row, metric, monthKey)
        : getCampaignMetric(item.campaign, metric, monthKey)
    )
    .filter((value): value is number => value != null);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return TOTAL_METRICS.has(metric)
    ? total
    : Math.round((total / values.length) * 100) / 100;
}

function SelectedSummaryRow({
  items,
  monthKey,
}: {
  items: SelectedItem[];
  monthKey: string | "total";
}) {
  return (
    <tr className="bg-indigo-500/10 text-indigo-100">
      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-indigo-400/20 bg-slate-900 px-4 py-2 font-medium">
        Selected ({items.length})
      </td>
      <td className="whitespace-nowrap border-b border-indigo-400/20 px-3 py-2 text-left text-xs text-indigo-200">
        Totals / avg
      </td>
      {METRIC_ORDER.map((key) => {
        const meta = METRIC_META[key];
        const val = getSelectedMetric(items, key, monthKey);
        return (
          <td
            key={key}
            className="whitespace-nowrap border-b border-indigo-400/20 px-3 py-2 text-right font-medium tabular-nums"
          >
            {formatMetricValue(val, meta.kind)}
          </td>
        );
      })}
    </tr>
  );
}

function SelectionCheckbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="h-3.5 w-3.5 rounded border-white/20 bg-slate-900 text-indigo-500"
    />
  );
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
