"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ClientLocationSummary, MetricKey } from "./types";
import { METRIC_META, METRIC_ORDER } from "./metric-meta";
import { formatMetricValue } from "./format";
import { getLocationMetric } from "./benchmarks";

interface Props {
  locations: ClientLocationSummary[];
  monthKey: string | "total";
  defaultSort?: MetricKey;
}

/**
 * Sortable leaderboard of clients with a small sparkline per row showing the
 * selected metric across the snapshot's time range.
 */
export function LeaderboardTable({
  locations,
  monthKey,
  defaultSort = "closed",
}: Props) {
  const [sortKey, setSortKey] = useState<MetricKey>(defaultSort);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const sorted = useMemo(() => {
    const meta = METRIC_META[sortKey];
    const effectiveDir =
      sortDir === "desc" ? (meta.higherIsBetter ? "desc" : "asc") : sortDir;
    const arr = locations.slice();
    arr.sort((a, b) => {
      const av = getLocationMetric(a, sortKey, monthKey);
      const bv = getLocationMetric(b, sortKey, monthKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return effectiveDir === "desc" ? bv - av : av - bv;
    });
    return arr;
  }, [locations, sortKey, sortDir, monthKey]);

  function handleSort(key: MetricKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
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
          {sorted.map((loc) => (
            <tr key={loc.locationId} className="hover:bg-white/5">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-slate-950/70 px-4 py-2">
                <Link
                  href={`/agency/dashboard/${loc.locationId}`}
                  className="flex flex-col text-slate-100 hover:text-indigo-300"
                >
                  <span className="font-medium">{loc.businessName}</span>
                  {loc.ownerName && (
                    <span className="text-[11px] text-slate-500">
                      {loc.ownerName}
                    </span>
                  )}
                  {!loc.included && (
                    <span className="text-[11px] text-amber-400">
                      {loc.errorMessage ?? "Not included"}
                    </span>
                  )}
                </Link>
              </td>
              {METRIC_ORDER.map((key) => {
                const meta = METRIC_META[key];
                const val = getLocationMetric(loc, key, monthKey);
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
