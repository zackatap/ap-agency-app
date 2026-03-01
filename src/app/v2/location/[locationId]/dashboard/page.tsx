"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

interface ConversionMetrics {
  shown: number;
  success: number;
  conversionPercent: number | null;
  stageCounts?: Record<string, number>;
}

interface ConversionData {
  pipeline: { id: string; name: string } | null;
  metrics: ConversionMetrics | null;
  message?: string;
}

export default function ConversionsDashboard() {
  const params = useParams();
  const searchParams = useSearchParams();
  const locationId = params?.locationId as string | undefined;
  const connectSource = searchParams?.get("source");
  const connectCount = searchParams?.get("count");
  const [data, setData] = useState<ConversionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<{ url: string; status?: number; body?: string } | null>(null);

  useEffect(() => {
    if (!locationId) {
      setLoading(false);
      return;
    }

    const apiUrl = `/api/conversions/${locationId}`;
    setLoading(true);
    setError(null);
    setDebug({ url: apiUrl });

    fetch(apiUrl)
      .then(async (res) => {
        const body = await res.text();
        setDebug((d) => ({ ...d!, status: res.status, body: body.slice(0, 500) }));
        if (res.status === 401) {
          const parsed = JSON.parse(body || "{}");
          if (parsed.needsAuth) {
            setError("NEEDS_AUTH");
            setData(null);
            return;
          }
        }
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
        }
        return JSON.parse(body);
      })
      .then((d) => { if (d !== undefined) setData(d); })
      .catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setLoading(false));
  }, [locationId]);

  if (!locationId) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        {/* Header */}
        <header className="mb-12">
          <h1 className="font-display text-4xl font-bold tracking-tight text-white/95 md:text-5xl">
            Conversions Dashboard
          </h1>
          <p className="mt-2 text-lg text-slate-400">
            Location:{" "}
            <code className="rounded bg-white/10 px-2 py-0.5 font-mono text-sm">
              {locationId}
            </code>
          </p>
          {connectSource && connectCount && (
            <p className="mt-1 text-sm text-slate-500">
              Connected: {connectCount} locations from {connectSource}
            </p>
          )}
        </header>

        {/* Content */}
        {loading && (
          <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-12 py-24">
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              <p className="text-slate-400">Loading pipeline metrics…</p>
            </div>
          </div>
        )}

        {error && error !== "NEEDS_AUTH" && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-8 py-6">
            <p className="font-medium text-red-300">Error</p>
            <p className="mt-1 text-red-200/90">{error}</p>
          </div>
        )}

        {error === "NEEDS_AUTH" && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-10">
            <p className="text-lg font-medium text-amber-200">
              Connect to GoHighLevel
            </p>
            <p className="mt-2 text-amber-200/90">
              Authorize this app to read pipeline and opportunity data for this location.
            </p>
            <a
              href={`/api/auth/ghl/authorize?locationId=${locationId}`}
              className="mt-6 inline-block rounded-xl bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-500"
            >
              Connect with GoHighLevel →
            </a>
          </div>
        )}

        {!loading && !error && !data && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-6">
            <p className="font-medium text-amber-200">No data received</p>
            <p className="mt-1 text-amber-200/90">
              The API request completed but returned nothing. Check the debug info below.
            </p>
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-8">
            {data.pipeline && data.metrics ? (
              <>
                {/* Pipeline card */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm">
                  <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
                    Pipeline
                  </h2>
                  <p className="mt-1 text-2xl font-semibold text-white">
                    {data.pipeline.name}
                  </p>
                </div>

                {/* Main conversion metric */}
                <div className="grid gap-6 md:grid-cols-3">
                  <MetricCard
                    label="Showed Up"
                    value={data.metrics.shown}
                    subtitle="opportunities"
                  />
                  <MetricCard
                    label="Success"
                    value={data.metrics.success}
                    subtitle="converted"
                  />
                  <MetricCard
                    label="Conversion Rate"
                    value={
                      data.metrics.conversionPercent != null
                        ? `${data.metrics.conversionPercent}%`
                        : "—"
                    }
                    subtitle="Showed Up → Success"
                    accent
                  />
                </div>

                {/* Raw stage counts (collapsible for debugging) */}
                {data.metrics.stageCounts &&
                  Object.keys(data.metrics.stageCounts).length > 0 && (
                    <details className="rounded-2xl border border-white/10 bg-white/5">
                      <summary className="cursor-pointer px-6 py-4 text-sm text-slate-400 hover:text-slate-300">
                        All stage counts
                      </summary>
                      <div className="border-t border-white/10 px-6 py-4">
                        <div className="flex flex-wrap gap-3">
                          {Object.entries(data.metrics.stageCounts).map(
                            ([stage, count]) => (
                              <span
                                key={stage}
                                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm"
                              >
                                <span className="text-slate-400">{stage}:</span>{" "}
                                <span className="font-medium">{count}</span>
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    </details>
                  )}
              </>
            ) : (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-8 py-6">
                <p className="font-medium text-amber-200">
                  No matching pipeline found
                </p>
                <p className="mt-1 text-amber-200/90">
                  {data.message ??
                    "Create a pipeline with 'Pain' in the name (e.g. Pain Patients) to see metrics here."}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Debug panel - always visible when we have debug info */}
        {debug && !loading && (
          <details className="mt-12 rounded-2xl border border-white/10 bg-black/20">
            <summary className="cursor-pointer px-6 py-4 text-sm font-medium text-slate-400 hover:text-slate-300">
              🔧 Debug info
            </summary>
            <div className="border-t border-white/10 px-6 py-4 font-mono text-xs text-slate-500">
              <p><strong>URL:</strong> {debug.url}</p>
              {debug.status != null && <p><strong>Status:</strong> {debug.status}</p>}
              {debug.body && (
                <p className="mt-2 break-all"><strong>Response:</strong> {debug.body}</p>
              )}
              <p className="mt-4 text-slate-600">
                To test the API directly, open: <br />
                <a
                  href={debug.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 underline"
                >
                  {typeof window !== "undefined" ? window.location.origin + debug.url : debug.url}
                </a>
              </p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  accent,
}: {
  label: string;
  value: string | number;
  subtitle: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-6 backdrop-blur-sm ${
        accent
          ? "border-indigo-500/50 bg-indigo-500/15"
          : "border-white/10 bg-white/5"
      }`}
    >
      <p className="text-sm font-medium uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p
        className={`mt-2 text-4xl font-bold tabular-nums ${
          accent ? "text-indigo-300" : "text-white"
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}
