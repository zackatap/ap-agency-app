"use client";

import { useEffect, useState } from "react";
import Script from "next/script";

type CampaignKey =
  | "base"
  | "pain"
  | "wellness"
  | "neuropathy"
  | "decompression"
  | "weight-loss"
  | "iv-therapy"
  | "custom";

interface CampaignConfig {
  key: CampaignKey;
  label: string;
  subtitle: string;
  formId: string;
  formName: string;
  height: number;
}

interface WorkflowItem {
  id: string;
  name: string;
  status?: string;
  url: string;
}

interface FunnelItem {
  id: string;
  name: string;
  status?: string;
  url: string;
}

interface GhlListAccessLog {
  endpoint: string;
  docs: string;
  requestUrl: string;
  totalRecordsFromApi: number;
  responseTopLevelKeys: string[];
  rawSamples: unknown[];
  normalizedFieldsWeUse: string[];
}

const CAMPAIGNS: CampaignConfig[] = [
  {
    key: "base",
    label: "Base",
    subtitle: "Core campaign configuration",
    formId: "AGPaDDX3SOZvX5Qbc2dR",
    formName: "SAAS OB - Base (Customizer)",
    height: 1669,
  },
  {
    key: "pain",
    label: "Pain",
    subtitle: "Pain / device campaign",
    formId: "Mbk6jkCFZW6bc1IsujFp",
    formName: "SAAS OB - Pain/Device Campaign",
    height: 3276,
  },
  {
    key: "wellness",
    label: "Wellness",
    subtitle: "Wellness offer settings",
    formId: "S6yAGOTXtPvA4FCfYJYM",
    formName: "SAAS OB - Wellness Campaign",
    height: 2295,
  },
  {
    key: "neuropathy",
    label: "Neuropathy",
    subtitle: "Neuropathy campaign settings",
    formId: "66MkNDlArWmMb0d1yWea",
    formName: "SAAS OB - Neuropathy",
    height: 2315,
  },
  {
    key: "decompression",
    label: "Decompression",
    subtitle: "Decompression campaign settings",
    formId: "tFMlWSJHRNYMPuSrdJDp",
    formName: "SAAS OB - Decompression",
    height: 2443,
  },
  {
    key: "weight-loss",
    label: "Weight Loss",
    subtitle: "Weight loss / red light campaign",
    formId: "8rSuEStMO6MQyIFD7vBZ",
    formName: "SAAS OB - Weight Loss/Red Light Campaign",
    height: 3195,
  },
  {
    key: "iv-therapy",
    label: "IV Therapy",
    subtitle: "IV therapy campaign settings",
    formId: "WpW3RLAXMmbTNc8GbZmD",
    formName: "SAAS OB - IV Therapy",
    height: 2275,
  },
  {
    key: "custom",
    label: "Custom",
    subtitle: "Build-your-own campaign",
    formId: "AThStffdHc7K6aEG8Ipf",
    formName: "SAAS OB - Custom Campaign",
    height: 2592,
  },
];

interface CustomizerAppProps {
  locationId?: string;
}

export function CustomizerApp({ locationId = "" }: CustomizerAppProps) {
  const [active, setActive] = useState<CampaignKey>("base");
  /** Cross-origin GHL forms can’t be styled from our page; invert+hue approximates a dark theme (images/colors may shift). */
  const [darkFormEmbed, setDarkFormEmbed] = useState(true);
  const [funnels, setFunnels] = useState<FunnelItem[]>([]);
  const [funnelsLoading, setFunnelsLoading] = useState(false);
  const [funnelsError, setFunnelsError] = useState<string | null>(null);
  const [funnelGhlLog, setFunnelGhlLog] = useState<GhlListAccessLog | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [workflowGhlLog, setWorkflowGhlLog] = useState<GhlListAccessLog | null>(
    null
  );

  const activeCampaign =
    CAMPAIGNS.find((campaign) => campaign.key === active) ?? CAMPAIGNS[0];

  useEffect(() => {
    if (active !== "base") return;
    if (!locationId) {
      setFunnels([]);
      setFunnelGhlLog(null);
      setFunnelsError(
        "No location connected for funnel lookup yet. Forms still work."
      );
      setWorkflows([]);
      setWorkflowGhlLog(null);
      setWorkflowsError(
        "No location connected for workflow lookup yet. Forms still work."
      );
      return;
    }

    let isCancelled = false;
    const load = async () => {
      setFunnelsLoading(true);
      setWorkflowsLoading(true);
      setFunnelsError(null);
      setWorkflowsError(null);
      setFunnelGhlLog(null);
      setWorkflowGhlLog(null);
      try {
        const [funnelsRes, workflowsRes] = await Promise.all([
          fetch(
            `/api/funnels/${encodeURIComponent(locationId)}?query=pain&debug=1`,
            { cache: "no-store" }
          ),
          fetch(
            `/api/workflows/${encodeURIComponent(locationId)}?query=pain&debug=1`,
            { cache: "no-store" }
          ),
        ]);

        const funnelsData = (await funnelsRes.json()) as {
          funnels?: FunnelItem[];
          error?: string;
          ghlAccess?: GhlListAccessLog;
        };
        const workflowsData = (await workflowsRes.json()) as {
          workflows?: WorkflowItem[];
          error?: string;
          ghlAccess?: GhlListAccessLog;
        };

        if (!isCancelled) {
          if (funnelsRes.ok) {
            setFunnels(funnelsData.funnels ?? []);
            setFunnelGhlLog(funnelsData.ghlAccess ?? null);
            setFunnelsError(null);
          } else {
            setFunnels([]);
            setFunnelGhlLog(null);
            setFunnelsError(
              funnelsData.error ?? "Failed to load funnels (landing pages)"
            );
          }

          if (workflowsRes.ok) {
            setWorkflows(workflowsData.workflows ?? []);
            setWorkflowGhlLog(workflowsData.ghlAccess ?? null);
            setWorkflowsError(null);
          } else {
            setWorkflows([]);
            setWorkflowGhlLog(null);
            setWorkflowsError(
              workflowsData.error ?? "Failed to load workflows"
            );
          }
        }
      } catch (error) {
        if (!isCancelled) {
          setFunnels([]);
          setFunnelGhlLog(null);
          setFunnelsError(
            error instanceof Error ? error.message : "Failed to load funnels"
          );
          setWorkflows([]);
          setWorkflowGhlLog(null);
          setWorkflowsError(
            error instanceof Error ? error.message : "Failed to load workflows"
          );
        }
      } finally {
        if (!isCancelled) {
          setFunnelsLoading(false);
          setWorkflowsLoading(false);
        }
      }
    };

    void load();
    return () => {
      isCancelled = true;
    };
  }, [active, locationId]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <Script
        src="https://link.automatedpractice.com/js/form_embed.js"
        strategy="afterInteractive"
      />
      <Script
        src="https://msg.everypages.com/scripts/proxy.js"
        strategy="afterInteractive"
      />

      <div className="mx-auto max-w-[1600px] px-4 py-6 lg:px-8">
        <header className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <p className="text-xs uppercase tracking-[0.2em] text-sky-300/90">
            SaaS Customizer
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">
            Campaign Customizer
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Edit campaign offers, messaging, and assets in one place.
          </p>
        </header>

        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_340px]">
          <aside className="rounded-2xl border border-white/10 bg-slate-900/60 p-3">
            <p className="px-2 pb-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
              Campaigns
            </p>
            <nav className="space-y-1">
              {CAMPAIGNS.map((campaign) => {
                const isActive = campaign.key === active;
                return (
                  <button
                    type="button"
                    key={campaign.key}
                    onClick={() => setActive(campaign.key)}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                      isActive
                        ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                        : "text-slate-300 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <p className="text-sm font-semibold">{campaign.label}</p>
                    <p className="text-xs text-slate-400">{campaign.subtitle}</p>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
            <div className="mb-3 flex flex-col gap-3 border-b border-white/10 pb-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {activeCampaign.label} Campaign
                </h2>
                <p className="text-sm text-slate-400">{activeCampaign.formName}</p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-white/30 bg-slate-900 text-sky-500"
                  checked={darkFormEmbed}
                  onChange={(e) => setDarkFormEmbed(e.target.checked)}
                />
                Dark-styled embed
              </label>
            </div>

            <p className="mb-2 text-[11px] leading-snug text-slate-500">
              The form lives on another domain, so we can’t inject CSS inside it. With{" "}
              <span className="text-slate-400">Dark-styled embed</span> on, we apply a
              color inversion filter to the whole iframe so light backgrounds read as dark
              (logos and images invert too—turn off if that’s distracting).
            </p>

            <div className="rounded-xl border border-white/10 bg-slate-950/40 p-2">
              <iframe
                src={`https://link.automatedpractice.com/widget/form/${activeCampaign.formId}`}
                style={{
                  width: "100%",
                  minHeight: `${activeCampaign.height}px`,
                  border: "none",
                  borderRadius: "10px",
                  ...(darkFormEmbed
                    ? {
                        filter:
                          "invert(1) hue-rotate(180deg) brightness(1.06) contrast(0.97)",
                      }
                    : {}),
                }}
                id={`inline-${activeCampaign.formId}`}
                data-layout="{'id':'INLINE'}"
                data-trigger-type="alwaysShow"
                data-trigger-value=""
                data-activation-type="alwaysActivated"
                data-activation-value=""
                data-deactivation-type="neverDeactivate"
                data-deactivation-value=""
                data-form-name={activeCampaign.formName}
                data-height={String(activeCampaign.height)}
                data-layout-iframe-id={`inline-${activeCampaign.formId}`}
                data-form-id={activeCampaign.formId}
                title={activeCampaign.formName}
              />
            </div>
          </main>

          <aside className="space-y-4">
            <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h3 className="text-sm font-semibold text-white">
                Landing pages (funnels)
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                From{" "}
                <a
                  href="https://marketplace.gohighlevel.com/docs/ghl/funnels/get-funnels"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-300/90 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200"
                >
                  GET /funnels/funnel/list
                </a>
                : funnels whose names contain{" "}
                <span className="font-semibold text-sky-300">pain</span>, sorted
                by name.
              </p>
              {!locationId && (
                <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                  No location ID detected for funnel lookup.
                </p>
              )}
              {locationId && active !== "base" && (
                <p className="mt-3 text-xs text-slate-400">
                  Switch to the Base tab to refresh funnel and workflow lists.
                </p>
              )}
              {locationId && active === "base" && funnelsLoading && (
                <p className="mt-3 text-sm text-slate-300">Loading funnels...</p>
              )}
              {locationId && active === "base" && funnelsError && (
                <p className="mt-3 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                  {funnelsError}
                </p>
              )}
              {locationId &&
                active === "base" &&
                !funnelsLoading &&
                !funnelsError &&
                funnels.length === 0 && (
                  <p className="mt-3 text-sm text-slate-300">
                    No matching funnels found.
                  </p>
                )}
              {locationId && active === "base" && funnels.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {funnels.map((funnel) => (
                    <li
                      key={funnel.id}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                    >
                      <a
                        href={funnel.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-sky-300 transition hover:text-sky-200 hover:underline"
                      >
                        {funnel.name}
                      </a>
                      <p className="text-xs text-slate-400">
                        {funnel.status || "Status unavailable"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {locationId &&
                active === "base" &&
                funnelGhlLog &&
                !funnelsLoading &&
                !funnelsError && (
                  <details className="mt-3 rounded-lg border border-white/10 bg-slate-950/50 p-2 text-xs">
                    <summary className="cursor-pointer font-medium text-slate-300">
                      Funnels — GHL API (debug)
                    </summary>
                    <p className="mt-2 text-slate-500">
                      Logged server-side as{" "}
                      <code className="text-slate-400">[funnels] GHL list success</code>{" "}
                      in Vercel. Below is the payload returned with{" "}
                      <code className="text-slate-400">debug=1</code>.
                    </p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-black/30 p-2 text-[10px] leading-relaxed text-slate-400">
                      {JSON.stringify(funnelGhlLog, null, 2)}
                    </pre>
                  </details>
                )}
            </section>

            <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
              <h3 className="text-sm font-semibold text-white">GHL Workflow</h3>
              <p className="mt-1 text-xs text-slate-400">
                Base page test: workflows containing{" "}
                <span className="font-semibold text-sky-300">pain</span>, sorted
                by name.
              </p>
              {locationId && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={`/api/auth/ghl/reauthorize?locationId=${encodeURIComponent(locationId)}`}
                    target="_top"
                    className="inline-flex rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs font-medium text-sky-200 ring-1 ring-sky-400/40 transition hover:bg-sky-500/30"
                  >
                    Hard Reconnect GHL
                  </a>
                  <a
                    href={`/api/debug/ghl-workflow-probe/${encodeURIComponent(locationId)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
                  >
                    API probe (diagnostics)
                  </a>
                </div>
              )}
              {!locationId && (
                <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                  No location ID detected for workflow lookup.
                </p>
              )}
              {locationId && active !== "base" && (
                <p className="mt-3 text-xs text-slate-400">
                  Switch to the Base tab to refresh funnel and workflow lists.
                </p>
              )}
              {locationId && active === "base" && workflowsLoading && (
                <p className="mt-3 text-sm text-slate-300">Loading workflows...</p>
              )}
              {locationId && active === "base" && workflowsError && (
                <p className="mt-3 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                  {workflowsError}
                </p>
              )}
              {locationId &&
                active === "base" &&
                !workflowsLoading &&
                !workflowsError &&
                workflows.length === 0 && (
                  <p className="mt-3 text-sm text-slate-300">
                    No matching workflows found.
                  </p>
                )}
              {locationId && active === "base" && workflows.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {workflows.map((workflow) => (
                    <li
                      key={workflow.id}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                    >
                      <a
                        href={workflow.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-sky-300 transition hover:text-sky-200 hover:underline"
                      >
                        {workflow.name}
                      </a>
                      <p className="text-xs text-slate-400">
                        {workflow.status || "Status unavailable"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {locationId &&
                active === "base" &&
                workflowGhlLog &&
                !workflowsLoading &&
                !workflowsError && (
                  <details className="mt-3 rounded-lg border border-white/10 bg-slate-950/50 p-2 text-xs">
                    <summary className="cursor-pointer font-medium text-slate-300">
                      Workflows — GHL API (debug)
                    </summary>
                    <p className="mt-2 text-slate-500">
                      Logged server-side as{" "}
                      <code className="text-slate-400">[workflows] GHL list success</code>{" "}
                      in Vercel. Below is the same payload shape returned with{" "}
                      <code className="text-slate-400">debug=1</code>.
                    </p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-black/30 p-2 text-[10px] leading-relaxed text-slate-400">
                      {JSON.stringify(workflowGhlLog, null, 2)}
                    </pre>
                  </details>
                )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
