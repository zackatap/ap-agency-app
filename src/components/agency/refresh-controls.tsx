"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatDateTime, formatRelative } from "./format";
import type { ClientAgencySnapshot, ClientMetaUsage } from "./types";

interface Props {
  latest: ClientAgencySnapshot | null;
  completeFinishedAt: string | null;
  /** Meta rate-limit usage from the last complete run (subtle indicator). */
  metaUsage?: ClientMetaUsage | null;
  onRefreshFinished?: () => void;
}

const USAGE_SOURCE_LABEL: Record<ClientMetaUsage["source"], string> = {
  app: "app-level",
  business: "ads (business use case)",
  "ad-account": "ad-account",
};

function SplitButtonMenu({
  disabled,
  menuClassName,
  triggerClassName,
  dividerClassName,
  children,
  menu,
}: {
  disabled?: boolean;
  menuClassName?: string;
  triggerClassName: string;
  dividerClassName: string;
  children: ReactNode;
  menu: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative flex items-stretch rounded-lg ${menuClassName ?? ""}`}>
      {children}
      <button
        type="button"
        aria-label="More options"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center rounded-r-lg px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${dividerClassName} ${triggerClassName}`}
      >
        ▾
      </button>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] rounded-md border border-white/10 bg-slate-900 p-1 text-sm shadow-xl"
        >
          {menu}
        </div>
      )}
    </div>
  );
}

/**
 * "Refresh data" button + last-refreshed label. Polls the status endpoint
 * every 3s while a run is in progress and fires `onRefreshFinished` when the
 * snapshot transitions from running to complete.
 */
export function RefreshControls({
  latest,
  completeFinishedAt,
  metaUsage,
  onRefreshFinished,
}: Props) {
  const [current, setCurrent] = useState<ClientAgencySnapshot | null>(latest);
  const [submitting, setSubmitting] = useState(false);
  const [zapierSubmitting, setZapierSubmitting] = useState(false);
  const [zapierAvailable, setZapierAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zapierMessage, setZapierMessage] = useState<string | null>(null);
  const previousStatus = useRef(latest?.status);

  useEffect(() => {
    setCurrent(latest);
  }, [latest]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/integrations/attention/trigger", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { available?: boolean } | null) => {
        if (!cancelled) setZapierAvailable(Boolean(body?.available));
      })
      .catch(() => {
        if (!cancelled) setZapierAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function handleRunAttentionWorkflow(scope: "flagged" | "red") {
    setZapierSubmitting(true);
    setZapierMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/integrations/attention/trigger?scope=${scope}`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to trigger Zapier");
      }
      setZapierMessage(
        scope === "red"
          ? "Red-only attention workflow started in Zapier."
          : "All-flagged attention workflow started in Zapier."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Zapier trigger failed");
    } finally {
      setZapierSubmitting(false);
    }
  }

  const isRunning = current?.status === "running";
  const progressPct =
    current && current.progressTotal > 0
      ? Math.round((current.progressCurrent / current.progressTotal) * 100)
      : 0;

  // Prefer the complete-snapshot usage passed in; fall back to whatever the
  // polled snapshot carries. Only show a real reading.
  const usage = metaUsage ?? current?.metaUsage ?? null;
  const usageTone =
    usage == null
      ? ""
      : usage.pct >= 90
        ? "text-red-300"
        : usage.pct >= 75
          ? "text-amber-300"
          : "text-slate-500";

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
          {usage != null && (
            <div
              className={usageTone}
              title={`Meta API rate-limit usage at the end of the last refresh: ${usage.pct}% of the ${
                USAGE_SOURCE_LABEL[usage.source]
              } budget. Meta throttles reads near 100%; it resets on a rolling ~1-hour window.`}
            >
              Meta usage: {usage.pct}%
            </div>
          )}
        </div>
        <SplitButtonMenu
          disabled={submitting || isRunning}
          menuClassName="bg-indigo-600"
          triggerClassName="text-white hover:bg-indigo-500"
          dividerClassName="border-l border-indigo-500/50"
          menu={
            <>
              {[5, 10, 25].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void handleRefresh(n);
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-white/5"
                >
                  Test run · first {n} clients
                </button>
              ))}
            </>
          }
        >
          <button
            type="button"
            onClick={() => handleRefresh()}
            disabled={submitting || isRunning}
            className="rounded-l-lg px-4 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning
              ? "Refreshing…"
              : submitting
                ? "Starting…"
                : "Refresh data"}
          </button>
        </SplitButtonMenu>
        {zapierAvailable && (
          <SplitButtonMenu
            disabled={zapierSubmitting || isRunning}
            menuClassName="border border-white/15 bg-slate-900/60"
            triggerClassName="text-slate-300 hover:bg-slate-800"
            dividerClassName="border-l border-white/10"
            menu={
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleRunAttentionWorkflow("flagged")}
                  className="block w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-white/5"
                >
                  All flagged · red, orange, yellow
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleRunAttentionWorkflow("red")}
                  className="block w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-white/5"
                >
                  Red only · most urgent
                </button>
              </>
            }
          >
            <button
              type="button"
              onClick={() => void handleRunAttentionWorkflow("flagged")}
              disabled={zapierSubmitting || isRunning}
              title="Runs the Zapier workflow for all flagged campaigns (red, orange, yellow). Refresh data first if numbers are stale."
              className="rounded-l-lg px-4 py-2 text-sm font-medium text-slate-200 transition-colors enabled:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {zapierSubmitting ? "Starting…" : "Run attention workflow"}
            </button>
          </SplitButtonMenu>
        )}
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
      {zapierMessage && (
        <div className="text-xs text-emerald-300" role="status">
          {zapierMessage}
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
