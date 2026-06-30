"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Meeting = {
  id: string;
  title: string;
  date: string;
  attendees: string;
  sourceLabel: string;
};

type GeneratedIdea = {
  title: string;
  type: string;
  source: string;
  status: string;
  hooks: string[];
};

type Props = {
  initialConnected: boolean;
  sheetUrl: string;
};

type GenerateScope = "new" | "recent" | "all" | "selected";

export default function ContentIdeasClient({
  initialConnected,
  sheetUrl,
}: Props) {
  const searchParams = useSearchParams();
  const [connected, setConnected] = useState(initialConnected);
  const [pendingNew, setPendingNew] = useState<number | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<GeneratedIdea[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [meetingFilter, setMeetingFilter] = useState("");

  const flash = useMemo(() => {
    const err = searchParams.get("error");
    const ok = searchParams.get("connected");
    if (err) return { type: "error" as const, text: decodeURIComponent(err) };
    if (ok) return { type: "success" as const, text: "Granola connected." };
    return null;
  }, [searchParams]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/agency/content-ideas/status");
      const data = await res.json();
      if (res.ok) {
        setConnected(Boolean(data.connected));
        if (typeof data.pendingNewMeetings === "number") {
          setPendingNew(data.pendingNewMeetings);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (flash?.type === "success") setConnected(true);
    if (flash?.type === "error") setError(flash.text);
    if (flash?.type === "success") setSuccess(flash.text);
  }, [flash]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runGenerate = useCallback(
    async (scope: GenerateScope, meetingIds?: string[]) => {
      setLoading(scope);
      setError(null);
      setSuccess(null);
      setIdeas([]);
      try {
        const res = await fetch("/api/agency/content-ideas/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope,
            meetingIds,
            daysBack: scope === "recent" ? 7 : scope === "new" ? 14 : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Generation failed");
        setIdeas(data.ideas ?? []);
        if (data.skipped) {
          setSuccess(data.reason ?? "No new meetings to process.");
        } else if (data.appended === 0) {
          setSuccess(
            `Checked ${data.meetingCount} meeting${data.meetingCount === 1 ? "" : "s"} — nothing worth adding right now.`
          );
        } else {
          setSuccess(
            `Added ${data.appended} idea${data.appended === 1 ? "" : "s"} to the sheet (from ${data.meetingCount} meeting${data.meetingCount === 1 ? "" : "s"}).`
          );
        }
        setPickerOpen(false);
        void refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Generation failed");
      } finally {
        setLoading(null);
      }
    },
    [refreshStatus]
  );

  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    setMeetingsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/content-ideas/meetings?daysBack=60");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load meetings");
      setMeetings(data.meetings ?? []);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meetings");
      setPickerOpen(false);
    } finally {
      setMeetingsLoading(false);
    }
  }, []);

  const filteredMeetings = meetings.filter((m) => {
    const q = meetingFilter.trim().toLowerCase();
    if (!q) return true;
    return (
      m.title.toLowerCase().includes(q) ||
      m.attendees.toLowerCase().includes(q) ||
      m.sourceLabel.toLowerCase().includes(q)
    );
  });

  function toggleMeeting(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {!connected && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Connect Granola once so we can read your meeting notes.{" "}
          <a
            href="/api/agency/granola/connect"
            className="font-semibold underline underline-offset-2"
          >
            Connect Granola
          </a>
        </div>
      )}

      {connected && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          Granola connected. Ideas append to your{" "}
          <a
            href={sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline underline-offset-2"
          >
            content ideas sheet
          </a>
          . Auto-sync is off — run manually when you want new ideas.
          {pendingNew !== null && pendingNew > 0 && (
            <>
              {" "}
              <span className="font-semibold">
                {pendingNew} new meeting{pendingNew === 1 ? "" : "s"} waiting.
              </span>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {success}
        </div>
      )}

      <button
        type="button"
        disabled={!connected || loading !== null}
        onClick={() => runGenerate("new")}
        className="w-full rounded-xl border border-emerald-400/40 bg-emerald-600/25 px-4 py-4 text-left transition hover:border-emerald-300/50 hover:bg-emerald-600/35 disabled:opacity-50"
      >
        <span className="block text-sm font-semibold text-white">
          {loading === "new" ? "Processing…" : "Process new meetings"}
        </span>
        <span className="mt-1 block text-xs text-emerald-100/80">
          Unprocessed recordings from the last 14 days · AI picks how many ideas
          fit (1–12)
        </span>
      </button>

      <div className="grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          disabled={!connected || loading !== null}
          onClick={() => runGenerate("recent")}
          className="rounded-xl border border-sky-400/30 bg-sky-500/15 px-4 py-4 text-left transition hover:border-sky-300/50 hover:bg-sky-500/20 disabled:opacity-50"
        >
          <span className="block text-sm font-semibold text-white">
            {loading === "recent" ? "Generating…" : "From recent meetings"}
          </span>
          <span className="mt-1 block text-xs text-sky-100/80">
            Last 7 days · dynamic count
          </span>
        </button>

        <button
          type="button"
          disabled={!connected || loading !== null}
          onClick={() => runGenerate("all")}
          className="rounded-xl border border-indigo-400/30 bg-indigo-500/15 px-4 py-4 text-left transition hover:border-indigo-300/50 hover:bg-indigo-500/20 disabled:opacity-50"
        >
          <span className="block text-sm font-semibold text-white">
            {loading === "all" ? "Generating…" : "From all meetings"}
          </span>
          <span className="mt-1 block text-xs text-indigo-100/80">
            Up to ~90 days · dynamic count
          </span>
        </button>

        <button
          type="button"
          disabled={!connected || loading !== null}
          onClick={openPicker}
          className="rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/15 px-4 py-4 text-left transition hover:border-fuchsia-300/50 hover:bg-fuchsia-500/20 disabled:opacity-50"
        >
          <span className="block text-sm font-semibold text-white">
            {loading === "selected" ? "Generating…" : "Pick meetings"}
          </span>
          <span className="mt-1 block text-xs text-fuchsia-100/80">
            Choose specific calls · dynamic count
          </span>
        </button>
      </div>

      {ideas.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
            Just added
          </h2>
          <ul className="mt-4 space-y-4">
            {ideas.map((idea) => (
              <li
                key={idea.title}
                className="rounded-xl border border-white/10 bg-white/5 p-4"
              >
                <p className="font-semibold text-white">{idea.title}</p>
                <p className="mt-1 text-xs text-slate-400">{idea.source}</p>
                <ol className="mt-3 list-decimal space-y-1 pl-4 text-sm text-slate-300">
                  {(Array.isArray(idea.hooks) ? idea.hooks : [idea.hooks]).map(
                    (hook) => (
                      <li key={hook}>{hook}</li>
                    )
                  )}
                </ol>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-slate-950 shadow-2xl">
            <div className="border-b border-white/10 px-5 py-4">
              <h2 className="text-lg font-semibold text-white">
                Select meetings
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Pick one or more calls to draft ideas from.
              </p>
              <input
                type="search"
                placeholder="Filter by title or attendee…"
                value={meetingFilter}
                onChange={(e) => setMeetingFilter(e.target.value)}
                className="mt-3 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-2">
              {meetingsLoading ? (
                <p className="px-3 py-6 text-sm text-slate-400">
                  Loading meetings…
                </p>
              ) : filteredMeetings.length === 0 ? (
                <p className="px-3 py-6 text-sm text-slate-400">
                  No meetings found.
                </p>
              ) : (
                <ul className="space-y-1">
                  {filteredMeetings.map((m) => {
                    const checked = selectedIds.has(m.id);
                    return (
                      <li key={m.id}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition ${
                            checked ? "bg-fuchsia-500/15" : "hover:bg-white/5"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMeeting(m.id)}
                            className="mt-1"
                          />
                          <span>
                            <span className="block text-sm font-medium text-white">
                              {m.title}
                            </span>
                            <span className="block text-xs text-slate-400">
                              {m.sourceLabel}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
              <span className="text-xs text-slate-400">
                {selectedIds.size} selected
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  className="rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={selectedIds.size === 0 || loading !== null}
                  onClick={() =>
                    runGenerate("selected", Array.from(selectedIds))
                  }
                  className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-500 disabled:opacity-50"
                >
                  Generate ideas
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
