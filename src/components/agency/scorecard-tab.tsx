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

/** Trailing windows. Each maps to a rollup preset. */
const WINDOWS = [
  { id: "last_3", days: 3, label: "3 days" },
  { id: "last_7", days: 7, label: "7 days" },
  { id: "last_14", days: 14, label: "14 days" },
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

/** Signed relative change as a tidy "+/-N%" string, or null when prior is ~0. */
function formatPctChange(delta: number, prior: number): string | null {
  if (Math.abs(prior) < 1e-9) return null;
  const pct = (delta / Math.abs(prior)) * 100;
  const sign = pct > 0 ? "+" : "−";
  const mag = Math.abs(pct);
  if (mag >= 1000) return `${sign}>999%`;
  const body = mag < 10 ? mag.toFixed(1) : Math.round(mag).toString();
  return `${sign}${body}%`;
}

function computeDelta(
  key: MetricKey,
  cur: number | null,
  prior: number | null
): { text: string; pct: string | null; tone: DeltaTone } {
  if (cur == null || prior == null) return { text: "—", pct: null, tone: "none" };
  const delta = cur - prior;
  if (Math.abs(delta) < 1e-9) return { text: "0", pct: null, tone: "flat" };
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
  return { text: `${sign}${body}`, pct: formatPctChange(delta, prior), tone };
}

const TONE_CLASS: Record<DeltaTone, string> = {
  good: "text-emerald-400",
  bad: "text-red-400",
  flat: "text-slate-500",
  none: "text-slate-600",
};

/** What the Attention tab knows about a campaign, keyed by campaignKey. */
interface AttentionInfo {
  urgency: number | null;
  code: string;
  reason: string;
}

/** Urgency badge styling, mirrored from the Attention tab (red / orange / yellow). */
const URGENCY_META: Record<
  number,
  { label: string; dot: string; text: string; ring: string }
> = {
  0: { label: "Red", dot: "bg-red-500", text: "text-red-300", ring: "ring-red-500/30" },
  1: { label: "Orange", dot: "bg-amber-500", text: "text-amber-300", ring: "ring-amber-500/30" },
  2: { label: "Yellow", dot: "bg-yellow-400", text: "text-yellow-200", ring: "ring-yellow-400/30" },
};

/** Header cell: sticks to the top on vertical scroll (matches the leaderboard). */
const TH_BASE =
  "sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 font-medium";

/** "Jul 18" from a YYYY-MM-DD string (parsed as local, no UTC shift). */
function formatDay(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** "Jul 18 – Jul 20" for a {startDate,endDate} range. */
function formatRange(
  range: { startDate: string; endDate: string } | null | undefined
): string {
  if (!range?.startDate || !range?.endDate) return "";
  return `${formatDay(range.startDate)} – ${formatDay(range.endDate)}`;
}

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
  // "client" groups a client's campaigns together (Active above 2nd); "urgency"
  // sorts by attention flag (red→yellow); metric keys sort by that KPI. Default
  // is client name, ascending.
  const [sortKey, setSortKey] = useState<MetricKey | "client" | "urgency">(
    "client"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // When on, only campaigns flagged in the Attention tab are shown.
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // Attention flags by campaignKey, used for the urgency badge + reason column.
  const [attentionByKey, setAttentionByKey] = useState<Map<string, AttentionInfo>>(
    new Map()
  );

  const load = useCallback(async (preset: WindowId) => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const params = new URLSearchParams({
        preset,
        clientDate: getTodayLocal(),
        // Anchor the window to the last refresh so the date line matches the data.
        anchor: "snapshot",
        // Floor the refresh time in the viewer's tz so the window ends on the
        // same date the "Last refresh" line shows (not the next day).
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Pull the rollup view and the attention flags together. Flags are
      // window-agnostic (3/7/14/30), so they hold across the window toggle.
      // Same tz so flag windows anchor to the refresh date like the table.
      const [res, attnRes] = await Promise.all([
        fetch(`/api/agency/rollup/latest?${params}`, { cache: "no-store" }),
        fetch(`/api/agency/attention?tz=${encodeURIComponent(tz)}`, {
          cache: "no-store",
        }),
      ]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load scorecard");

      if (attnRes.ok) {
        const attn = await attnRes.json();
        const map = new Map<string, AttentionInfo>();
        for (const r of (attn?.rows ?? []) as Array<Record<string, unknown>>) {
          map.set(String(r.campaign_key), {
            urgency: typeof r.urgency === "number" ? r.urgency : null,
            code: String(r.attention_code ?? ""),
            reason: String(r.reason ?? ""),
          });
        }
        setAttentionByKey(map);
      }

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
    let visible = view.campaigns.filter((c) => c.included);
    // "Attention only" narrows to the same set the Attention tab shows.
    if (flaggedOnly) {
      visible = visible.filter((c) => attentionByKey.has(c.campaignKey));
    }
    const dir = sortDir === "desc" ? -1 : 1;
    const urgencyOf = (c: ClientCampaignSummary) => {
      const u = attentionByKey.get(c.campaignKey)?.urgency;
      return typeof u === "number" ? u : null;
    };
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
      if (sortKey === "urgency") {
        const au = urgencyOf(a);
        const bu = urgencyOf(b);
        // Unflagged rows sink; flagged ties fall back to client grouping.
        if (au == null && bu == null) return byClient(a, b);
        if (au == null) return 1;
        if (bu == null) return -1;
        if (au === bu) return byClient(a, b);
        return (au - bu) * dir;
      }
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
  }, [view, sortKey, sortDir, flaggedOnly, attentionByKey]);

  const toggleMetric = useCallback((key: MetricKey) => {
    setExpandedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: MetricKey | "client" | "urgency") => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        return prevKey;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
              Window
              {loading && view && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-indigo-200">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-300" />
                  Updating…
                </span>
              )}
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
            {view?.range && (
              <div className="mt-2 text-xs text-slate-400">
                <span className="text-slate-300">
                  {formatRange(view.range)}
                </span>
                {view.priorRange && (
                  <>
                    {" "}
                    <span className="text-slate-600">vs prior</span>{" "}
                    <span className="text-slate-500">
                      {formatRange(view.priorRange)}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Show
            </div>
            <div className="mt-2 inline-flex rounded-lg border border-white/10 bg-slate-950/40 p-1">
              <button
                type="button"
                onClick={() => setFlaggedOnly(false)}
                className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                  !flaggedOnly
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                All campaigns
              </button>
              <button
                type="button"
                onClick={() => setFlaggedOnly(true)}
                className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                  flaggedOnly
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                Attention only
              </button>
            </div>
          </div>
        </div>
        <div className="text-right text-xs text-slate-400">
          <div>
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
        <div
          aria-busy={loading}
          className={`max-h-[calc(100vh-16rem)] max-w-full overflow-auto rounded-2xl border border-white/10 bg-slate-900/40 transition-opacity duration-200 ${
            loading ? "pointer-events-none opacity-50" : "opacity-100"
          }`}
        >
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="sticky left-0 top-0 z-30 whitespace-nowrap border-b border-r border-white/10 bg-slate-900 px-4 py-3 font-medium shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]">
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
                <th className={`${TH_BASE} border-l text-left`}>
                  <button
                    type="button"
                    onClick={() => toggleSort("urgency")}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-white ${
                      sortKey === "urgency" ? "text-white" : ""
                    }`}
                  >
                    Urgency
                    {sortKey === "urgency" && (
                      <span aria-hidden>{sortDir === "desc" ? "▾" : "▴"}</span>
                    )}
                  </button>
                </th>
                {SCORECARD_METRICS.map((m) => {
                  const active = sortKey === m.key;
                  const exp = expandedMetrics.has(m.key);
                  return (
                    <Fragment key={m.key}>
                      <th className={`${TH_BASE} border-l text-right`}>
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
                        <th className={`${TH_BASE} text-right text-slate-500`}>
                          Prev
                        </th>
                      )}
                      {exp && (
                        <th className={`${TH_BASE} text-right text-slate-500`}>
                          Δ
                        </th>
                      )}
                    </Fragment>
                  );
                })}
                <th className={`${TH_BASE} border-l text-left`}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const attn = attentionByKey.get(c.campaignKey);
                const urgency = attn?.urgency ?? null;
                return (
                  <tr
                    key={c.campaignKey}
                    className="group transition-colors hover:bg-white/5"
                  >
                    <td className="sticky left-0 z-10 whitespace-nowrap border-b border-b-white/5 border-r border-r-white/10 bg-slate-900 px-4 py-3 shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)] transition-colors group-hover:bg-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">
                          {c.businessName}
                        </span>
                        <StatusBadge status={c.status} />
                      </div>
                      {(() => {
                        // Show pipeline + campaign keyword together so two
                        // campaigns sharing one pipeline (e.g. Leads · Pain vs
                        // Leads · Decompression) are distinguishable.
                        const pn = c.pipelineName?.trim() || null;
                        const ck = c.campaignKeyword?.trim() || null;
                        const subtitle =
                          pn && ck && pn.toLowerCase() !== ck.toLowerCase()
                            ? `${pn} · ${ck}`
                            : pn ?? ck ?? c.adAccountId;
                        return subtitle ? (
                          <div className="text-xs text-slate-400">{subtitle}</div>
                        ) : null;
                      })()}
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3">
                      {urgency != null ? (
                        <UrgencyBadge urgency={urgency} />
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    {SCORECARD_METRICS.map((m) => {
                      const cur = metricValue(c.totals, m.key);
                      const exp = expandedMetrics.has(m.key);
                      if (!exp) {
                        return (
                          <td
                            key={m.key}
                            className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-right tabular-nums text-slate-100"
                          >
                            {formatValue(m.key, cur)}
                          </td>
                        );
                      }
                      const prior = metricValue(c.priorTotals, m.key);
                      const delta = computeDelta(m.key, cur, prior);
                      return (
                        <Fragment key={m.key}>
                          <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-right tabular-nums text-slate-100">
                            {formatValue(m.key, cur)}
                          </td>
                          <td className="whitespace-nowrap border-b border-b-white/5 px-3 py-3 text-right tabular-nums text-slate-400">
                            {formatValue(m.key, prior)}
                          </td>
                          <td
                            className={`whitespace-nowrap border-b border-b-white/5 px-3 py-3 text-right tabular-nums ${TONE_CLASS[delta.tone]}`}
                          >
                            <div>{delta.text}</div>
                            {delta.pct && (
                              <div className="text-[11px] text-slate-500">
                                {delta.pct}
                              </div>
                            )}
                          </td>
                        </Fragment>
                      );
                    })}
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-slate-300">
                      {attn?.reason ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {view && rows.length === 0 && !loading && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          {flaggedOnly
            ? "Nothing flagged right now. Every active campaign is within thresholds."
            : "No campaigns with data in this window."}
        </div>
      )}
    </div>
  );
}

function UrgencyBadge({ urgency }: { urgency: number }) {
  const meta = URGENCY_META[urgency] ?? URGENCY_META[2];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full bg-white/5 px-2.5 py-1 text-xs font-semibold ring-1 ${meta.ring} ${meta.text}`}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
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
