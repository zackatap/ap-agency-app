"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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

type WindowId = (typeof WINDOWS)[number]["id"] | "custom";

/**
 * Scorecard columns, ads block first then the appt/success funnel.
 * Leads + CPL use Meta; appts / showed / success come from the GHL pipeline.
 */
const SCORECARD_METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "adSpend", label: "Ad spend" },
  { key: "metaLeads", label: "Leads" },
  { key: "cpl", label: "CPL" },
  { key: "linkClicks", label: "Link clicks" },
  { key: "cplc", label: "CPLC" },
  { key: "ctr", label: "CTR" },
  { key: "totalAppts", label: "Appts" },
  { key: "bookingRate", label: "Booking rate" },
  { key: "showed", label: "Showed" },
  { key: "showRate", label: "Show rate" },
  { key: "closed", label: "Success" },
  { key: "closeRate", label: "Close rate" },
];

/**
 * Classify a persisted Meta error message so the UI can react appropriately:
 *   rate-limit → we're throttled (temporary, self-clears)
 *   transient  → a Meta/network hiccup (temporary, auto-retried)
 *   disconnect → a real "app not assigned / no permission" (needs action)
 * Mirrors the server-side `isMetaRateLimitError` / `isMetaTransientError`,
 * kept local so this client component doesn't pull the Graph fetch module
 * (and its token access) into the browser bundle.
 */
function metaErrorKind(
  message: string | null | undefined
): "rate-limit" | "transient" | "disconnect" {
  if (!message) return "disconnect";
  const m = message.toLowerCase();
  if (
    m.includes("request limit reached") ||
    m.includes("rate limit") ||
    m.includes("too many calls") ||
    m.includes("user request limit") ||
    m.includes("calls to this api have exceeded")
  ) {
    return "rate-limit";
  }
  if (
    m.includes("temporarily unavailable") ||
    m.includes("unknown error") ||
    m.includes("non-json response") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("please reduce the amount of data") ||
    m.includes("try again")
  ) {
    return "transient";
  }
  return "disconnect";
}

/** Always show CRM vs Meta when either side has a count this window. */
function leadSourceComparison(
  totals: ClientCampaignWindowTotals
): {
  crm: number;
  meta: number;
  direction: "meta_high" | "crm_high" | "match";
  largeGap: boolean;
} | null {
  const crm = typeof totals.leads === "number" ? totals.leads : 0;
  const meta = typeof totals.metaLeads === "number" ? totals.metaLeads : 0;
  if (crm === 0 && meta === 0) return null;
  const direction =
    meta > crm ? "meta_high" : crm > meta ? "crm_high" : "match";
  const diff = Math.abs(crm - meta);
  const base = Math.min(crm, meta);
  // e.g. 10 vs 15 → 5/10 = 50%. One side at 0 with the other > 0 always flags.
  const largeGap =
    direction !== "match" && (base === 0 || diff / base >= 0.5);
  return { crm, meta, direction, largeGap };
}

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
    case "metaLeads":
    case "linkClicks":
    case "totalAppts":
    case "showed":
    case "closed":
      return formatCount(value);
    case "cpl":
    case "cplc":
    case "cps":
    case "cpClose":
      return formatMoneyDecimal(value);
    case "ctr":
    case "bookingRate":
    case "showRate":
    case "closeRate":
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
    case "metaLeads":
    case "linkClicks":
    case "totalAppts":
    case "showed":
    case "closed":
      body = formatCount(magnitude);
      break;
    case "cpl":
    case "cplc":
    case "cps":
    case "cpClose":
      body = formatMoneyDecimal(magnitude);
      break;
    case "ctr":
    case "bookingRate":
    case "showRate":
    case "closeRate":
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

/** A single flag (one engine) for a campaign. */
interface FlagInfo {
  urgency: number | null;
  code: string;
  reason: string;
}

/**
 * What the attention feed knows about a campaign, keyed by campaignKey.
 *   quantity     — Ads performance (R/O/Y, Meta SoT)
 *   quantityData — Ads Meta↔CRM leak (Data badge, can sit next to performance)
 *   quality      — Appts/Success funnel (account manager)
 */
interface AttentionInfo {
  quantity: FlagInfo | null;
  quantityData: FlagInfo | null;
  quality: FlagInfo | null;
}

/**
 * Urgency badge styling. 0/1/2 = red/orange/yellow; 3 = Data hygiene
 * (Meta↔CRM lead leak on Ads, or CRM not updated past Appt Confirmed on Appts).
 */
const URGENCY_META: Record<
  number,
  { label: string; dot: string; text: string; ring: string }
> = {
  0: { label: "Red", dot: "bg-red-500", text: "text-red-300", ring: "ring-red-500/30" },
  1: { label: "Orange", dot: "bg-amber-500", text: "text-amber-300", ring: "ring-amber-500/30" },
  2: { label: "Yellow", dot: "bg-yellow-400", text: "text-yellow-200", ring: "ring-yellow-400/30" },
  3: { label: "Data", dot: "bg-sky-400", text: "text-sky-200", ring: "ring-sky-400/30" },
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

/** True when a needs-setup reason points at a missing GHL OAuth token. */
function isGhlDisconnected(reason: string | null): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes("oauth token") || r.includes("app not installed");
}

/**
 * Pipeline + campaign keyword, so two campaigns sharing one pipeline stay
 * distinguishable. Falls back to ad account id when neither is set.
 */
function subtitleFor(c: ClientCampaignSummary): string | null {
  const pn = c.pipelineName?.trim() || null;
  const ck = c.campaignKeyword?.trim() || null;
  if (pn && ck && pn.toLowerCase() !== ck.toLowerCase()) return `${pn} · ${ck}`;
  return pn ?? ck ?? c.adAccountId;
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
  // "client" groups a client's campaigns together (Active above 2nd);
  // "quantity"/"quality" sort by that engine's flag (red→yellow); metric keys
  // sort by that KPI. Default is client name, ascending.
  const [sortKey, setSortKey] = useState<
    MetricKey | "client" | "quantity" | "quality"
  >("client");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Independent on/off filters. Off/off shows everything; turning one (or both)
  // on narrows to campaigns flagged by that engine (union when both are on).
  const [showQuantity, setShowQuantity] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  // Custom range inputs (draft) + the applied range that actually drives a
  // fetch. Apply commits the draft so typing doesn't refetch on every keystroke.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<{
    from: string;
    to: string;
  } | null>(null);
  // Attention flags by campaignKey, used for the urgency badge + reason column.
  const [attentionByKey, setAttentionByKey] = useState<Map<string, AttentionInfo>>(
    new Map()
  );
  // Campaigns whose per-account Meta retry is in flight.
  const [retryingKeys, setRetryingKeys] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (preset: WindowId, from?: string, to?: string) => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const params = new URLSearchParams({
        preset,
        clientDate: getTodayLocal(),
        // Anchor trailing windows to the last refresh (ignored for custom, which
        // uses the explicit from/to below and its own same-length prior period).
        anchor: "snapshot",
        // Floor the refresh time in the viewer's tz so the window ends on the
        // same date the "Last refresh" line shows (not the next day).
        tz,
      });
      if (preset === "custom" && from && to) {
        params.set("from", from);
        params.set("to", to);
      }
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
          const quantity: FlagInfo | null =
            typeof r.urgency === "number"
              ? {
                  urgency: r.urgency,
                  code: String(r.attention_code ?? ""),
                  reason: String(r.reason ?? ""),
                }
              : null;
          const quantityData: FlagInfo | null =
            typeof r.data_urgency === "number"
              ? {
                  urgency: r.data_urgency,
                  code: String(r.data_code ?? ""),
                  reason: String(r.data_reason ?? ""),
                }
              : null;
          const quality: FlagInfo | null =
            typeof r.quality_urgency === "number"
              ? {
                  urgency: r.quality_urgency,
                  code: String(r.quality_code ?? ""),
                  reason: String(r.quality_reason ?? ""),
                }
              : null;
          map.set(String(r.campaign_key), { quantity, quantityData, quality });
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
    },
    []
  );

  useEffect(() => {
    // Custom waits for an applied from/to (set by Apply); trailing windows fetch
    // immediately on toggle. reloadKey bumps when a rollup refresh finishes,
    // pulling the fresh snapshot in without a tab switch.
    if (windowId === "custom") {
      if (appliedCustom) void load("custom", appliedCustom.from, appliedCustom.to);
      return;
    }
    void load(windowId);
  }, [load, windowId, reloadKey, appliedCustom]);

  const retryCampaign = useCallback(
    async (campaignKey: string) => {
      setRetryingKeys((prev) => new Set(prev).add(campaignKey));
      try {
        const res = await fetch(
          `/api/agency/rollup/refresh-campaign?campaignKey=${encodeURIComponent(
            campaignKey
          )}`,
          { method: "POST" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "Retry failed");
          return;
        }
        // Pull the fresh slice back into the table.
        if (windowId === "custom" && appliedCustom) {
          await load("custom", appliedCustom.from, appliedCustom.to);
        } else {
          await load(windowId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Retry failed");
      } finally {
        setRetryingKeys((prev) => {
          const next = new Set(prev);
          next.delete(campaignKey);
          return next;
        });
      }
    },
    [load, windowId, appliedCustom]
  );

  const applyCustomRange = useCallback(() => {
    if (!customFrom || !customTo) return;
    // New object identity each click re-triggers the effect even if unchanged.
    setAppliedCustom({ from: customFrom, to: customTo });
  }, [customFrom, customTo]);

  const rows = useMemo(() => {
    if (!view) return [];
    // Only campaigns that produced data this snapshot — needs-setup and
    // failed campaigns carry no spend/lead signal worth scoring.
    let visible = view.campaigns.filter((c) => c.included);
    // Off/off shows everything; one or both on narrows to campaigns flagged by
    // the selected engine(s) (union). Matches the Show toggles.
    if (showQuantity || showQuality) {
      visible = visible.filter((c) => {
        const a = attentionByKey.get(c.campaignKey);
        if (!a) return false;
        return (
          (showQuantity && (a.quantity != null || a.quantityData != null)) ||
          (showQuality && a.quality != null)
        );
      });
    }
    const dir = sortDir === "desc" ? -1 : 1;
    const flagUrgencyOf = (
      c: ClientCampaignSummary,
      category: "quantity" | "quality"
    ) => {
      if (category === "quality") {
        const u = attentionByKey.get(c.campaignKey)?.quality?.urgency;
        return typeof u === "number" ? u : null;
      }
      // Ads sort: performance urgency wins; Data-only (3) sorts after R/O/Y.
      const a = attentionByKey.get(c.campaignKey);
      const perf = a?.quantity?.urgency;
      const data = a?.quantityData?.urgency;
      if (typeof perf === "number") return perf;
      if (typeof data === "number") return data;
      return null;
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
      if (sortKey === "quantity" || sortKey === "quality") {
        const au = flagUrgencyOf(a, sortKey);
        const bu = flagUrgencyOf(b, sortKey);
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
  }, [view, sortKey, sortDir, showQuantity, showQuality, attentionByKey]);

  const attentionCounts = useMemo(() => {
    if (!view) return null;
    const quantity = { total: 0, red: 0, orange: 0, yellow: 0, data: 0 };
    const quality = { total: 0, red: 0, orange: 0, yellow: 0, data: 0 };
    const tallyLevel = (
      bucket: typeof quantity,
      flag: FlagInfo | null | undefined
    ) => {
      if (!flag || typeof flag.urgency !== "number") return;
      if (flag.urgency === 0) bucket.red += 1;
      else if (flag.urgency === 1) bucket.orange += 1;
      else if (flag.urgency === 2) bucket.yellow += 1;
      else if (flag.urgency === 3) bucket.data += 1;
    };
    for (const c of view.campaigns) {
      if (!c.included) continue;
      const attn = attentionByKey.get(c.campaignKey);
      if (attn?.quantity || attn?.quantityData) quantity.total += 1;
      tallyLevel(quantity, attn?.quantity);
      tallyLevel(quantity, attn?.quantityData);
      if (attn?.quality) quality.total += 1;
      tallyLevel(quality, attn?.quality);
    }
    return { quantity, quality };
  }, [view, attentionByKey]);

  // Campaigns the roster expects but that couldn't be read this snapshot
  // (almost always: GHL app not installed for that location). They produce no
  // data, so the scored table hides them — but a silently-missing client is
  // worse than a greyed row. Dedupe on the display signature so a stale
  // campaign-key orphan doesn't list the same client twice.
  const disconnected = useMemo(() => {
    // A flag filter hides these — a needs-setup row can't be flagged.
    if (!view || showQuantity || showQuality) return [];
    const seen = new Set<string>();
    const out: ClientCampaignSummary[] = [];
    for (const c of view.campaigns) {
      if (c.included || !c.needsSetupReason) continue;
      const sig = `${c.locationId}|${c.pipelineName ?? ""}|${c.campaignKeyword ?? ""}|${c.status}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(c);
    }
    return out.sort((a, b) => a.businessName.localeCompare(b.businessName));
  }, [view, showQuantity, showQuality]);

  const toggleMetric = useCallback((key: MetricKey) => {
    setExpandedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: MetricKey | "client" | "quantity" | "quality") => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }, [sortKey]);

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
              <button
                type="button"
                onClick={() => setWindowId("custom")}
                className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                  windowId === "custom"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                Custom
              </button>
            </div>
            {windowId === "custom" && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">
                    From
                  </label>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">
                    To
                  </label>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={applyCustomRange}
                  disabled={!customFrom || !customTo || loading}
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
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
            <div className="mt-2 inline-flex gap-2">
              <button
                type="button"
                aria-pressed={showQuantity}
                onClick={() => setShowQuantity((v) => !v)}
                title="Show only campaigns with a lead / CPL / spend flag (media buyer)"
                className={`rounded-lg border px-4 py-1.5 text-sm transition-colors ${
                  showQuantity
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-white/10 bg-slate-950/40 text-slate-300 hover:text-white"
                }`}
              >
                Ads
              </button>
              <button
                type="button"
                aria-pressed={showQuality}
                onClick={() => setShowQuality((v) => !v)}
                title="Show only campaigns with a booking / show / sign-on flag (account manager)"
                className={`rounded-lg border px-4 py-1.5 text-sm transition-colors ${
                  showQuality
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-white/10 bg-slate-950/40 text-slate-300 hover:text-white"
                }`}
              >
                Appts/Success
              </button>
            </div>
            {(showQuantity || showQuality) && attentionCounts && (
              <div className="mt-2 space-y-1 text-xs">
                {showQuantity && (
                  <FlagCountLine
                    label="Ads"
                    counts={attentionCounts.quantity}
                    levels={[0, 1, 2, 3]}
                  />
                )}
                {showQuality && (
                  <FlagCountLine
                    label="Appts/Success"
                    counts={attentionCounts.quality}
                    levels={[0, 1, 2, 3]}
                  />
                )}
              </div>
            )}
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

      {view && (rows.length > 0 || disconnected.length > 0) && (
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
                    onClick={() => toggleSort("quantity")}
                    title="Lead / CPL / spend flag (media buyer)"
                    className={`inline-flex items-center gap-1 transition-colors hover:text-white ${
                      sortKey === "quantity" ? "text-white" : ""
                    }`}
                  >
                    Ads
                    {sortKey === "quantity" && (
                      <span aria-hidden>{sortDir === "desc" ? "▾" : "▴"}</span>
                    )}
                  </button>
                </th>
                <th className={`${TH_BASE} border-l text-left`}>
                  <button
                    type="button"
                    onClick={() => toggleSort("quality")}
                    title="Booking / show / no-show / sign-on flag (account manager)"
                    className={`inline-flex items-center gap-1 transition-colors hover:text-white ${
                      sortKey === "quality" ? "text-white" : ""
                    }`}
                  >
                    Appts/Success
                    {sortKey === "quality" && (
                      <span aria-hidden>{sortDir === "desc" ? "▾" : "▴"}</span>
                    )}
                  </button>
                </th>
                <th className={`${TH_BASE} border-l text-left`}>Reason</th>
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
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const attn = attentionByKey.get(c.campaignKey);
                const quantityFlag = attn?.quantity ?? null;
                const quantityDataFlag = attn?.quantityData ?? null;
                const qualityFlag = attn?.quality ?? null;
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
                        const subtitle = subtitleFor(c);
                        return subtitle ? (
                          <div className="text-xs text-slate-400">{subtitle}</div>
                        ) : null;
                      })()}
                      {(() => {
                        // Surface ad accounts the app can't read. Pair with $0
                        // spend so a transient blip on a spending account
                        // doesn't cry wolf.
                        const spend = c.totals.adSpend;
                        const noSpend = spend == null || spend === 0;
                        if (!c.metaError || !noSpend) return null;

                        const kind = metaErrorKind(c.metaError);
                        const retrying = retryingKeys.has(c.campaignKey);

                        // Re-pull just this account into the current snapshot —
                        // one Meta call, not a full-agency refresh.
                        const retryButton = (
                          <button
                            type="button"
                            onClick={() => void retryCampaign(c.campaignKey)}
                            disabled={retrying}
                            title="Re-pull just this account's Meta data into the current snapshot. Doesn't re-run the whole agency, so it won't burn API quota."
                            className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {retrying ? "Retrying…" : "Retry ↻"}
                          </button>
                        );

                        // Temporary failures (throttling or a Meta/network
                        // hiccup) clear themselves — "Connect" won't fix them,
                        // so show a neutral, self-explaining badge instead of
                        // the amber "not connected" alarm.
                        let badge: ReactNode = null;
                        if (kind === "rate-limit" || kind === "transient") {
                          const isRate = kind === "rate-limit";
                          const label = isRate
                            ? "Meta rate limited"
                            : "Meta temporarily down";
                          const title = isRate
                            ? `Meta throttled this ad account — ${c.metaError}. App-level rate limit, not a disconnect. It clears on its own (usually within the hour) and the numbers backfill on the next refresh.`
                            : `Meta couldn't be reached for this ad account — ${c.metaError}. A transient Meta/API hiccup, not a disconnect. It's retried automatically and backfills on the next refresh.`;
                          badge = (
                            <span
                              title={title}
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
                                isRate
                                  ? "bg-sky-500/15 text-sky-200 ring-sky-500/30"
                                  : "bg-slate-500/15 text-slate-300 ring-slate-400/30"
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isRate ? "bg-sky-400" : "bg-slate-400"
                                }`}
                              />
                              {label}
                            </span>
                          );
                        } else if (c.metaConnectUrl) {
                          // Genuine "app not assigned" — keep the connect link.
                          badge = (
                            <a
                              href={c.metaConnectUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Meta API can't read this ad account — ${c.metaError}. Click to assign the app in Business settings.`}
                              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 ring-1 ring-amber-500/30 transition-colors hover:bg-amber-500/25"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                              Meta not connected · Connect ↗
                            </a>
                          );
                        }

                        if (!badge) return null;
                        return (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {badge}
                            {retryButton}
                          </div>
                        );
                      })()}
                      {(() => {
                        const cmp = leadSourceComparison(c.totals);
                        if (!cmp) return null;
                        const title =
                          cmp.direction === "meta_high"
                            ? `Meta counted ${cmp.meta} paid leads; ${cmp.crm} reached the CRM. Check lead-form sync, pipeline stage mapping, and tag filter.`
                            : cmp.direction === "crm_high"
                              ? `CRM has ${cmp.crm} leads; Meta attributed ${cmp.meta}. Extra CRM leads are usually organic/referral or missing pixel/CAPI tagging.`
                              : `CRM and Meta agree: ${cmp.crm} leads this window.`;
                        const dotClass = cmp.largeGap
                          ? "bg-red-400"
                          : cmp.direction === "meta_high"
                            ? "bg-amber-400"
                            : cmp.direction === "crm_high"
                              ? "bg-slate-400"
                              : "bg-emerald-400";
                        return (
                          <span
                            title={title}
                            className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
                              cmp.largeGap
                                ? "bg-red-500/10 text-red-200 ring-red-400/60"
                                : "bg-slate-500/15 text-slate-300 ring-slate-400/30"
                            }`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                            Leads: CRM {cmp.crm} · Meta {cmp.meta}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3">
                      {quantityFlag?.urgency != null ||
                      quantityDataFlag?.urgency != null ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {quantityFlag?.urgency != null && (
                            <UrgencyBadge urgency={quantityFlag.urgency} />
                          )}
                          {quantityDataFlag?.urgency != null && (
                            <UrgencyBadge urgency={quantityDataFlag.urgency} />
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3">
                      {qualityFlag?.urgency != null ? (
                        <UrgencyBadge urgency={qualityFlag.urgency} />
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-slate-300">
                      {quantityFlag?.reason && (
                        <div className="whitespace-nowrap">
                          <span className="text-slate-500">Ads:</span>{" "}
                          {quantityFlag.reason}
                        </div>
                      )}
                      {quantityDataFlag?.reason && (
                        <div className="whitespace-nowrap">
                          <span className="text-slate-500">Data:</span>{" "}
                          {quantityDataFlag.reason}
                        </div>
                      )}
                      {qualityFlag?.reason && (
                        <div className="whitespace-nowrap">
                          <span className="text-slate-500">Appts:</span>{" "}
                          {qualityFlag.reason}
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
                  </tr>
                );
              })}
              {disconnected.map((c) => {
                const subtitle = subtitleFor(c);
                const ghl = isGhlDisconnected(c.needsSetupReason);
                return (
                  <tr
                    key={`ns-${c.campaignKey}`}
                    className="group bg-slate-950/40 transition-colors hover:bg-white/5"
                  >
                    <td className="sticky left-0 z-10 whitespace-nowrap border-b border-b-white/5 border-r border-r-white/10 bg-slate-900 px-4 py-3 shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)] transition-colors group-hover:bg-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-300">
                          {c.businessName}
                        </span>
                        <StatusBadge status={c.status} />
                      </div>
                      {subtitle && (
                        <div className="text-xs text-slate-500">{subtitle}</div>
                      )}
                      <span
                        title={c.needsSetupReason ?? undefined}
                        className="mt-1 inline-flex items-center gap-1 rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] font-medium text-slate-300 ring-1 ring-slate-400/30"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                        {ghl ? "GHL not connected" : "Needs setup"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-slate-600">
                      —
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-slate-600">
                      —
                    </td>
                    <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-slate-500">
                      {c.needsSetupReason ?? ""}
                    </td>
                    {SCORECARD_METRICS.map((m) => {
                      const exp = expandedMetrics.has(m.key);
                      return (
                        <Fragment key={m.key}>
                          <td className="whitespace-nowrap border-b border-b-white/5 border-l border-l-white/10 px-4 py-3 text-right tabular-nums text-slate-600">
                            —
                          </td>
                          {exp && (
                            <td className="whitespace-nowrap border-b border-b-white/5 px-3 py-3 text-right tabular-nums text-slate-600">
                              —
                            </td>
                          )}
                          {exp && (
                            <td className="whitespace-nowrap border-b border-b-white/5 px-3 py-3 text-right tabular-nums text-slate-600">
                              —
                            </td>
                          )}
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {view && rows.length === 0 && disconnected.length === 0 && !loading && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          {showQuantity || showQuality
            ? "Nothing flagged for that filter right now. Every active campaign is within thresholds."
            : "No campaigns with data in this window."}
        </div>
      )}
    </div>
  );
}

/** One line of flag counts (e.g. "Appts/Success: 4 flagged · 1 Red · 2 Yellow"). */
function FlagCountLine({
  label,
  counts,
  levels,
}: {
  label: string;
  counts: { total: number; red: number; orange: number; yellow: number; data: number };
  levels: number[];
}) {
  const countFor = (level: number) =>
    level === 0
      ? counts.red
      : level === 1
        ? counts.orange
        : level === 2
          ? counts.yellow
          : counts.data;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium text-slate-200">
        {label}: {counts.total} flagged
      </span>
      {levels.map((level) => {
        const meta = URGENCY_META[level];
        const count = countFor(level);
        if (!count) return null;
        return (
          <span
            key={level}
            className={`inline-flex items-center gap-1 ${meta.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {count} {meta.label}
          </span>
        );
      })}
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
