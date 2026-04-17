"use client";

import { useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelative } from "./format";
import type { ClientAgencySnapshot } from "./types";

interface Props {
  latest: ClientAgencySnapshot | null;
  completeFinishedAt: string | null;
  onRefreshFinished?: () => void;
}

/**
 * "Refresh data" button + last-refreshed label. Polls the status endpoint
 * every 3s while a run is in progress and fires `onRefreshFinished` when the
 * snapshot transitions from running to complete.
 */
export function RefreshControls({
  latest,
  completeFinishedAt,
  onRefreshFinished,
}: Props) {
  const [current, setCurrent] = useState<ClientAgencySnapshot | null>(latest);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousStatus = useRef(latest?.status);

  useEffect(() => {
    setCurrent(latest);
  }, [latest]);

  useEffect(() => {
    if (!current || current.status !== "running") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/agency/rollup/status", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { latest: ClientAgencySnapshot | null };
        setCurrent(body.latest);
        const prev = previousStatus.current;
        const next = body.latest?.status;
        if (prev === "running" && next === "complete") {
          onRefreshFinished?.();
        }
        previousStatus.current = next;
      } catch {
        // Ignore transient polling errors
      }
    }, 3000);
    return () => clearInterval(id);
  }, [current, onRefreshFinished]);

  async function handleRefresh(limit?: number) {
    setSubmitting(true);
    setError(null);
    try {
      const qs = limit ? `?limit=${limit}` : "";
      const res = await fetch(`/api/agency/rollup/refresh${qs}`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to start refresh");
      }
      const body = (await res.json()) as { snapshotId?: number };
      if (body.snapshotId) {
        const statusRes = await fetch("/api/agency/rollup/status", {
          cache: "no-store",
        });
        if (statusRes.ok) {
          const statusBody = (await statusRes.json()) as {
            latest: ClientAgencySnapshot | null;
          };
          setCurrent(statusBody.latest);
          previousStatus.current = statusBody.latest?.status;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setSubmitting(false);
    }
  }

  const isRunning = current?.status === "running";
  const progressPct =
    current && current.progressTotal > 0
      ? Math.round((current.progressCurrent / current.progressTotal) * 100)
      : 0;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        <div className="text-right text-xs text-slate-400">
          <div>
            Last refresh:{" "}
            <span className="text-slate-200">
              {formatRelative(completeFinishedAt)}
            </span>
          </div>
          <div>{formatDateTime(completeFinishedAt)}</div>
        </div>
        <div className="flex items-stretch overflow-hidden rounded-lg bg-indigo-600">
          <button
            type="button"
            onClick={() => handleRefresh()}
            disabled={submitting || isRunning}
            className="px-4 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning
              ? "Refreshing…"
              : submitting
                ? "Starting…"
                : "Refresh data"}
          </button>
          <details className="relative">
            <summary
              className={`flex h-full cursor-pointer items-center border-l border-indigo-500/50 px-2 text-sm text-white hover:bg-indigo-500 ${
                submitting || isRunning ? "pointer-events-none opacity-60" : ""
              }`}
            >
              ▾
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-white/10 bg-slate-900 p-1 text-sm shadow-xl">
              {[5, 10, 25].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => handleRefresh(n)}
                  className="block w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-white/5"
                >
                  Test run · first {n} clients
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
      {isRunning && (
        <div className="w-72 space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="text-right text-[11px] text-slate-400">
            {current?.progressLabel ?? "Running…"} · {current?.progressCurrent}/
            {current?.progressTotal}
          </div>
        </div>
      )}
      {error && (
        <div className="text-xs text-red-300" role="alert">
          {error}
        </div>
      )}
      {current?.status === "failed" && (
        <div className="text-xs text-amber-300">
          Last run failed — {current.progressLabel ?? "see errors below"}.
        </div>
      )}
    </div>
  );
}
