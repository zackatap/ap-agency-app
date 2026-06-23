"use client";

import { useCallback, useEffect, useState } from "react";
import { formatRelative } from "./format";

interface AttentionRow {
  campaign_key: string;
  client_name: string | null;
  pipeline_name: string | null;
  campaign_name: string | null;
  status: string;
  reason: string;
  attention_code: string;
  urgency: number | null;
  clickup_relation_id: string;
}

interface AttentionFeed {
  snapshotId: number | null;
  snapshotFinishedAt: string | null;
  rows: AttentionRow[];
}

const URGENCY_META: Record<number, { label: string; dot: string; text: string; ring: string }> = {
  0: { label: "Red", dot: "bg-red-500", text: "text-red-300", ring: "ring-red-500/30" },
  1: { label: "Orange", dot: "bg-amber-500", text: "text-amber-300", ring: "ring-amber-500/30" },
  2: { label: "Yellow", dot: "bg-yellow-400", text: "text-yellow-200", ring: "ring-yellow-400/30" },
};

export function AttentionTab({ reloadKey = 0 }: { reloadKey?: number }) {
  const [feed, setFeed] = useState<AttentionFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/attention", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load attention feed");
      setFeed(data as AttentionFeed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load attention feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const rows = feed?.rows ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Flagged campaigns
          </div>
          <div className="mt-1 text-lg font-semibold text-white">
            {rows.length} need{rows.length === 1 ? "s" : ""} attention
          </div>
        </div>
        <div className="text-right text-xs text-slate-400">
          <div>Sorted by urgency: red, then orange, then yellow.</div>
          {feed?.snapshotFinishedAt && (
            <div className="mt-1">
              Data refreshed {formatRelative(feed.snapshotFinishedAt)}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      {loading && !feed && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          Loading attention feed…
        </div>
      )}

      {feed && rows.length > 0 && (
        <div className="max-h-[calc(100vh-16rem)] max-w-full overflow-auto rounded-2xl border border-white/10 bg-slate-900/40">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 font-medium">
                  Urgency
                </th>
                <th className="sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 font-medium">
                  Client
                </th>
                <th className="sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 font-medium">
                  Campaign
                </th>
                <th className="sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 font-medium">
                  Reason
                </th>
                <th className="sticky top-0 z-20 whitespace-nowrap border-b border-white/10 bg-slate-900 px-4 py-3 text-right font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = URGENCY_META[r.urgency ?? 2] ?? URGENCY_META[2];
                return (
                  <tr
                    key={r.campaign_key}
                    className="transition-colors hover:bg-white/5"
                  >
                    <td className="border-b border-white/5 px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-2 rounded-full bg-white/5 px-2.5 py-1 text-xs font-semibold ring-1 ${meta.ring} ${meta.text}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </td>
                    <td className="border-b border-white/5 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">
                          {r.client_name ?? "—"}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                    </td>
                    <td className="border-b border-white/5 px-4 py-3 text-slate-300">
                      {r.campaign_name ?? r.pipeline_name ?? "—"}
                    </td>
                    <td className="border-b border-white/5 px-4 py-3 text-slate-200">
                      {r.reason}
                    </td>
                    <td className="border-b border-white/5 px-4 py-3 text-right">
                      <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-slate-300">
                        {r.attention_code}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {feed && rows.length === 0 && !loading && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-8 text-center text-slate-300">
          Nothing flagged right now. Every active campaign is within thresholds.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
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
