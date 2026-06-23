"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type {
  ClientCampaignWindowTotals,
  ClientCampaignSummary,
  ClientRollupView,
  MetricKey,
} from "./types";
import { METRIC_META } from "./metric-meta";
import {
  formatCount,
  formatMoney,
  formatMoneyDecimal,
  formatPercent,
  formatRelative,
} from "./format";
import { getTodayLocal } from "@/lib/date-ranges";

/** 3 / 7 / 30-day trailing windows. Each maps to a rollup preset. */
const WINDOWS = [
  { id: "last_3", days: 3, label: "3 days" },
  { id: "last_7", days: 7, label: "7 days" },
  { id: "last_30", days: 30, label: "30 days" },
] as const;

type WindowId = (typeof WINDOWS)[number]["id"];

/** The six KPIs, in the order the agency reads them. */
const SCORECARD_METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "adSpend", label: "Ad spend" },
  { key: "leads", label: "Leads" },
  { key: "cpl", label: "CPL" },
  { key: "linkClicks", label: "Link clicks" },
  { key: "cplc", label: "CPLC" },
  { key: "ctr", label: "CTR" },
];

function metricValue(
  totals: ClientCampaignWindowTotals,
  key: MetricKey
): number | null {
  const raw = totals[key as keyof ClientCampaignWindowTotals];
  return typeof raw === "number" ? raw : null;
}

function formatValue(key: MetricKey, value: number | null): string {
  if (value == null) return "—";
  switch (key) {
    case "adSpend":
      return formatMoney(value);
    case "leads":
    case "linkClicks":
      return formatCount(value);
    case "cpl":
    case "cplc":
      return formatMoneyDecimal(value);
    case "ctr":
      return formatPercent(value);
    default:
      return formatCount(value);
  }
}

type DeltaTone = "good" | "bad" | "flat" | "none";

function computeDelta(
  key: MetricKey,
  cur: number | null,
  prior: number | null
): { text: string; tone: DeltaTone } {
  if (cur == null || prior == null) return { text: "—", tone: "none" };
  const delta = cur - prior;
  if (Math.abs(delta) < 1e-9) return { text: "0", tone: "flat" };
  const higherIsBetter = METRIC_META[key].higherIsBetter;
  const tone: DeltaTone =
    (delta > 0 && higherIsBetter) || (delta < 0 && !higherIsBetter)
      ? "good"
      : "bad";
  const sign = delta > 0 ? "+" : "−";
  const magnitude = Math.abs(delta);
  let body: string;
  switch (key) {
    case "adSpend":
      body = formatMoney(magnitude);
      break;
    case "leads":
    case "linkClicks":
      body = formatCount(magnitude);
      break;
    case "cpl":
    case "cplc":
      body = formatMoneyDecimal(magnitude);
      break;
    case "ctr":
      body = `${magnitude.toFixed(1)} pts`;
      break;
    default:
      body = formatCount(magnitude);
  }
  return { text: `${sign}${body}`, tone };
}

const TONE_CLASS: Record<DeltaTone, string> = {
  good: "text-emerald-400",
  bad: "text-red-400",
  flat: "text-slate-500",
  none: "text-slate-600",
};

export function ScorecardTab({ reloadKey = 0 }: { reloadKey?: number }) {
  const [windowId, setWindowId] = useState<WindowId>("last_30");
  const [view, setView] = useState<ClientRollupView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Metrics whose column is expanded to show prior value + delta across all rows.
  const [expandedMetrics, setExpandedMetrics] = useState<Set<MetricKey>>(
    new Set()
  );
  // "client" groups a client's campaigns together (Active above 2nd); the
  // metric keys sort by that KPI. Default is client name, ascending.
  const [sortKey, setSortKey] = useState<MetricKey | "client">("client");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const load = useCallback(async (preset: WindowId) => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const params = new URLSearchParams({
        preset,
        clientDate: getTodayLocal(),
      });
      const res = await fetch(`/api/agency/rollup/latest?${params}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load scorecard");
      if (!data.snapshot) {
        setView(null);
        setMessage(
          data.message ??
            "No rollup snapshot yet — open the Performance tab and click Refresh data."
        );
        return;
      }
      setView(data as ClientRollupView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scorecard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(windowId);
    // reloadKey bumps when an agency rollup refresh finishes, pulling the
    // freshly-stored snapshot into the scorecard without a tab switch.
  }, [load, windowId, reloadKey]);

  const rows = useMemo(() => {
    if (!view) return [];
    // Only campaigns that produced data this snapshot — needs-setup and
    // failed campaigns carry no spend/lead signal worth scoring.
    const visible = view.campaigns.filter((c) => c.included);
    const dir = sortDir === "desc" ? -1 : 1;
    // Keeps a client's campaigns adjacent: name first, then Active before 2nd
    // (status order is fixed regardless of direction), then campaign label.
    const byClient = (a: ClientCampaignSummary, b: ClientCampaignSummary) => {
      const nameCmp = a.businessName.localeCompare(b.businessName);
      if (nameCmp !== 0) return nameCmp * dir;
      const ar = a.status === "2ND CMPN" ? 1 : 0;
      const br = b.status === "2ND CMPN" ? 1 : 0;
      if (ar !== br) return ar - br;
      return (a.campaignKeyword ?? a.pipelineName ?? "").localeCompare(
        b.campaignKeyword ?? b.pipelineName ?? ""
      );
    };
    return visible.slice().sort((a, b) => {
      if (sortKey === "client") return byClient(a, b);
      const av = metricValue(a.totals, sortKey);
      const bv = metricValue(b.totals, sortKey);
      // Nulls always sort to the bottom regardless of direction; ties fall back
      // to the client grouping so multi-campaign clients stay together.
      if (av == null && bv == null) return byClient(a, b);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return byClient(a, b);
      return (av - bv) * dir;
    });
  }, [view, sortKey, sortDir]);

  const toggleMetric = useCallback((key: MetricKey) => {
    setExpandedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: MetricKey | "client") => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        return prevKey;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  const windowDef = WINDOWS.find((w) => w.id === windowId)!;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Window
          </div>
          <div className="mt-2 inline-flex rounded-lg border border-white/10 bg-slate-950/40 p-1">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWindowId(w.id)}
                className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                  windowId === w.id
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-right text-xs text-slate-400">
          <div>
            Last {windowDef.days} days vs the prior {windowDef.days} days
          </div>
          <div className="mt-1">
            Tip: click the <span className="text-slate-200">›</span> on any
            column to compare it to the prior period.
          </div>
          {view?.snapshot?.finishedAt && (
            <div className="mt-1">
              Data refreshed {formatRelative(view.snapshot.finishedAt)}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          {message}
        </div>
      )}

      {loading && !view && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          Loading scorecard…
        </div>
      )}

      {view && rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-900/40">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="sticky left-0 z-20 border-r border-white/10 bg-slate-900 px-4 py-3 font-medium">
                  <button
                    type="button"
                    onClick={() => toggleSort("client")}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-white ${
                      sortKey === "client" ? "text-white" : ""
                    }`}
                  >
                    Client
                    {sortKey === "client" && (
                      <span aria-hidden>{sortDir === "desc" ? "▾" : "▴"}</span>
                    )}
                  </button>
                </th>
                {SCORECARD_METRICS.map((m) => {
                  const active = sortKey === m.key;
                  const exp = expandedMetrics.has(m.key);
                  return (
                    <Fragment key={m.key}>
                      <th className="border-l border-white/10 px-4 py-3 text-right font-medium">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleSort(m.key)}
                            className={`inline-flex items-center gap-1 transition-colors hover:text-white ${
                              active ? "text-white" : ""
                            }`}
                          >
                            {m.label}
                            {active && (
                              <span aria-hidden>
                                {sortDir === "desc" ? "▾" : "▴"}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleMetric(m.key)}
                            title={
                              exp
                                ? "Hide prior period"
                                : "Compare to prior period"
                            }
                            aria-label={
                              exp
                                ? `Collapse ${m.label}`
                                : `Expand ${m.label} to compare`
                            }
                            className={`rounded px-1 text-sm transition-colors hover:bg-white/10 ${
                              exp ? "text-indigo-300" : "text-slate-500 hover:text-white"
                            }`}
                          >
                            {exp ? "‹" : "›"}
                          </button>
                        </div>
                      </th>
                      {exp && (
                        <th className="px-3 py-3 text-right font-medium text-slate-500">
                          Prev
                        </th>
                      )}
                      {exp && (
                        <th className="px-3 py-3 pr-4 text-right font-medium text-slate-500">
                          Δ
                        </th>
                      )}
                    </Fragment>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.campaignKey}
                  className="group border-b border-white/5 transition-colors hover:bg-white/5"
                >
                  <td className="sticky left-0 z-10 border-r border-white/10 bg-slate-900 px-4 py-3 transition-colors group-hover:bg-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">
                        {c.businessName}
                      </span>
                      <StatusBadge status={c.status} />
                    </div>
                    {(c.pipelineName ??
                      c.campaignKeyword ??
                      c.adAccountId) && (
                      <div className="text-xs text-slate-400">
                        {c.pipelineName ?? c.campaignKeyword ?? c.adAccountId}
                      </div>
                    )}
                  </td>
                  {SCORECARD_METRICS.map((m) => {
                    const cur = metricValue(c.totals, m.key);
                    const exp = expandedMetrics.has(m.key);
                    if (!exp) {
                      return (
                        <td
                          key={m.key}
                          className="border-l border-white/10 px-4 py-3 text-right tabular-nums text-slate-100"
                        >
                          {formatValue(m.key, cur)}
                        </td>
                      );
                    }
                    const prior = metricValue(c.priorTotals, m.key);
                    const delta = computeDelta(m.key, cur, prior);
                    return (
                      <Fragment key={m.key}>
                        <td className="border-l border-white/10 px-4 py-3 text-right tabular-nums text-slate-100">
                          {formatValue(m.key, cur)}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                          {formatValue(m.key, prior)}
                        </td>
                        <td
                          className={`px-3 py-3 pr-4 text-right tabular-nums ${TONE_CLASS[delta.tone]}`}
                        >
                          {delta.text}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view && rows.length === 0 && !loading && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          No campaigns with data in this window.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ClientCampaignSummary["status"] }) {
  const is2nd = status === "2ND CMPN";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        is2nd
          ? "bg-fuchsia-500/15 text-fuchsia-200"
          : "bg-emerald-500/15 text-emerald-200"
      }`}
    >
      {is2nd ? "2nd" : "Active"}
    </span>
  );
}
