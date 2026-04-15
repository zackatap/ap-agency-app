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
  /**
   * When set, the right column loads GHL funnels + workflows whose names contain this
   * substring (API lowercases for matching). Omitted on Base — no GHL lists there.
   */
  resourceSearchQuery?: string;
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

function IconExternalLink({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
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
    resourceSearchQuery: "pain",
  },
  {
    key: "wellness",
    label: "Wellness",
    subtitle: "Wellness offer settings",
    formId: "S6yAGOTXtPvA4FCfYJYM",
    formName: "SAAS OB - Wellness Campaign",
    height: 2295,
    resourceSearchQuery: "wellness",
  },
  {
    key: "neuropathy",
    label: "Neuropathy",
    subtitle: "Neuropathy campaign settings",
    formId: "66MkNDlArWmMb0d1yWea",
    formName: "SAAS OB - Neuropathy",
    height: 2315,
    resourceSearchQuery: "neuropathy",
  },
  {
    key: "decompression",
    label: "Decompression",
    subtitle: "Decompression campaign settings",
    formId: "tFMlWSJHRNYMPuSrdJDp",
    formName: "SAAS OB - Decompression",
    height: 2443,
    resourceSearchQuery: "decompression",
  },
  {
    key: "weight-loss",
    label: "Weight Loss",
    subtitle: "Weight loss / red light campaign",
    formId: "8rSuEStMO6MQyIFD7vBZ",
    formName: "SAAS OB - Weight Loss/Red Light Campaign",
    height: 3195,
    resourceSearchQuery: "weight loss",
  },
  {
    key: "iv-therapy",
    label: "IV Therapy",
    subtitle: "IV therapy campaign settings",
    formId: "WpW3RLAXMmbTNc8GbZmD",
    formName: "SAAS OB - IV Therapy",
    height: 2275,
    resourceSearchQuery: "iv therapy",
  },
  {
    key: "custom",
    label: "Custom",
    subtitle: "Build-your-own campaign",
    formId: "AThStffdHc7K6aEG8Ipf",
    formName: "SAAS OB - Custom Campaign",
    height: 2592,
    resourceSearchQuery: "custom",
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
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);

  const activeCampaign =
    CAMPAIGNS.find((campaign) => campaign.key === active) ?? CAMPAIGNS[0];
  const resourceQuery = activeCampaign.resourceSearchQuery;
  const showGhlResources = Boolean(resourceQuery);

  useEffect(() => {
    if (!resourceQuery) {
      setFunnels([]);
      setFunnelsError(null);
      setWorkflows([]);
      setWorkflowsError(null);
      setFunnelsLoading(false);
      setWorkflowsLoading(false);
      return;
    }

    if (!locationId) {
      setFunnels([]);
      setFunnelsError(
        "No location connected for GHL lookup yet. Forms still work."
      );
      setWorkflows([]);
      setWorkflowsError(
        "No location connected for GHL lookup yet. Forms still work."
      );
      return;
    }

    const q = encodeURIComponent(resourceQuery);

    let isCancelled = false;
    const load = async () => {
      setFunnelsLoading(true);
      setWorkflowsLoading(true);
      setFunnelsError(null);
      setWorkflowsError(null);
      try {
        const [funnelsRes, workflowsRes] = await Promise.all([
          fetch(`/api/funnels/${encodeURIComponent(locationId)}?query=${q}`, {
            cache: "no-store",
          }),
          fetch(
            `/api/workflows/${encodeURIComponent(locationId)}?query=${q}`,
            { cache: "no-store" }
          ),
        ]);

        const funnelsData = (await funnelsRes.json()) as {
          funnels?: FunnelItem[];
          error?: string;
        };
        const workflowsData = (await workflowsRes.json()) as {
          workflows?: WorkflowItem[];
          error?: string;
        };

        if (!isCancelled) {
          if (funnelsRes.ok) {
            setFunnels(funnelsData.funnels ?? []);
            setFunnelsError(null);
          } else {
            setFunnels([]);
            setFunnelsError(
              funnelsData.error ?? "Failed to load funnels (landing pages)"
            );
          }

          if (workflowsRes.ok) {
            setWorkflows(workflowsData.workflows ?? []);
            setWorkflowsError(null);
          } else {
            setWorkflows([]);
            setWorkflowsError(
              workflowsData.error ?? "Failed to load workflows"
            );
          }
        }
      } catch (error) {
        if (!isCancelled) {
          setFunnels([]);
          setFunnelsError(
            error instanceof Error ? error.message : "Failed to load funnels"
          );
          setWorkflows([]);
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
  }, [active, locationId, resourceQuery]);

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
              <span className="text-slate-400">Dark-styled embed</span> on, we invert
              colors and blend so former white areas pick up this page’s background instead
              of flat black (images still invert—turn off if that’s distracting).
            </p>

            <div
              className="isolate rounded-xl border border-white/10 bg-slate-900/60 p-2"
              style={{ backgroundColor: "rgb(15 23 42 / 0.72)" }}
            >
              <iframe
                src={`https://link.automatedpractice.com/widget/form/${activeCampaign.formId}`}
                style={{
                  width: "100%",
                  minHeight: `${activeCampaign.height}px`,
                  border: "none",
                  borderRadius: "10px",
                  display: "block",
                  backgroundColor: "transparent",
                  ...(darkFormEmbed
                    ? {
                        filter:
                          "invert(1) hue-rotate(180deg) brightness(1.06) contrast(0.97)",
                        mixBlendMode: "lighten",
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

          <aside className="flex flex-col gap-3">
            {locationId && (
              <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-900/60 p-3 backdrop-blur-sm">
                <a
                  href={`/api/auth/ghl/reauthorize?locationId=${encodeURIComponent(locationId)}`}
                  target="_top"
                  className="inline-flex rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-200 ring-1 ring-sky-400/35 transition hover:bg-sky-500/25"
                >
                  Hard Reconnect GHL
                </a>
                <a
                  href={`/api/debug/ghl-workflow-probe/${encodeURIComponent(locationId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex rounded-lg border border-white/10 bg-slate-950/40 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
                >
                  Workflow API probe
                </a>
              </div>
            )}

            {!showGhlResources && (
              <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 backdrop-blur-sm">
                <p className="text-[0.65rem] font-medium uppercase tracking-[0.18em] text-slate-400">
                  GHL resources
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Open <span className="text-slate-100">Pain</span>,{" "}
                  <span className="text-slate-100">Wellness</span>, or another
                  campaign tab to see funnels and workflows whose names match that
                  campaign.
                </p>
                {!locationId && (
                  <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/10 px-3 py-2 text-xs text-amber-100/90">
                    No location ID in the URL — GHL lists need a connected sub-account.
                  </p>
                )}
              </section>
            )}

            {showGhlResources && (
              <>
                <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 backdrop-blur-sm">
                  <p className="text-[0.65rem] font-medium uppercase tracking-[0.18em] text-slate-400">
                    Landing pages
                  </p>
                  {/*
                    Production: extra funnel context (uncomment if needed)
                    <h3 className="mt-1 text-sm font-semibold text-white">
                      Funnels matching “{resourceQuery}”
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      <a href="https://marketplace.gohighlevel.com/docs/ghl/funnels/get-funnels" target="_blank" rel="noreferrer" className="text-sky-300/90 underline decoration-sky-500/30 underline-offset-2 hover:text-sky-200">GET /funnels/funnel/list</a>, filtered and sorted by name.
                    </p>
                  */}
                  {!locationId && (
                    <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/10 px-3 py-2 text-xs text-amber-100/90">
                      No location ID — connect GHL to load funnels.
                    </p>
                  )}
                  {locationId && funnelsLoading && (
                    <p className="mt-3 text-sm text-slate-400">Loading funnels…</p>
                  )}
                  {locationId && funnelsError && (
                    <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/95">
                      {funnelsError}
                    </p>
                  )}
                  {locationId &&
                    !funnelsLoading &&
                    !funnelsError &&
                    funnels.length === 0 && (
                      <p className="mt-3 text-sm text-slate-400">
                        No landing page found for this campaign (Spanish-only
                        matches are excluded).
                      </p>
                    )}
                  {locationId && funnels[0] && (
                    <a
                      href={funnels[0].url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 block w-full rounded-xl border border-white/10 px-3 py-2.5 text-left transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400/50"
                    >
                      <p className="text-sm font-semibold text-white">
                        {activeCampaign.label} Landing Page
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                        Open in new tab
                        <IconExternalLink className="text-slate-400" />
                      </p>
                    </a>
                  )}
                  {/*
                    Production: GHL raw response (re-enable client debug=1 + ghlAccess state)
                    {locationId && funnelGhlLog && !funnelsLoading && !funnelsError && (
                      <details className="mt-3 rounded-lg border border-white/10 bg-slate-950/50 p-2 text-xs">
                        <summary className="cursor-pointer font-medium text-slate-400">Funnels — API debug</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-black/25 p-2 text-[10px] leading-relaxed text-slate-500">{JSON.stringify(funnelGhlLog, null, 2)}</pre>
                      </details>
                    )}
                  */}
                </section>

                <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 backdrop-blur-sm">
                  <p className="text-[0.65rem] font-medium uppercase tracking-[0.18em] text-slate-400">
                    Workflows
                  </p>
                  {/*
                    Production: extra workflow context (uncomment if needed)
                    <h3 className="mt-1 text-sm font-semibold text-white">
                      Workflows matching “{resourceQuery}”
                    </h3>
                    <p className="mt-1 text-xs text-slate-400">
                      Same keyword as this tab’s campaign title, sorted by name.
                    </p>
                  */}
                  {!locationId && (
                    <p className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/10 px-3 py-2 text-xs text-amber-100/90">
                      No location ID — connect GHL to load workflows.
                    </p>
                  )}
                  {locationId && workflowsLoading && (
                    <p className="mt-3 text-sm text-slate-400">Loading workflows…</p>
                  )}
                  {locationId && workflowsError && (
                    <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/95">
                      {workflowsError}
                    </p>
                  )}
                  {locationId &&
                    !workflowsLoading &&
                    !workflowsError &&
                    workflows.length === 0 && (
                      <p className="mt-3 text-sm text-slate-400">
                        No workflows matched this campaign keyword.
                      </p>
                    )}
                  {locationId && workflows.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {workflows.map((workflow, index) => (
                        <li key={workflow.id}>
                          <a
                            href={workflow.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block w-full rounded-xl border border-white/10 px-3 py-2.5 text-left transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400/50"
                          >
                            <p className="text-sm font-semibold text-white">
                              {activeCampaign.label} Workflow
                              {workflows.length > 1 ? ` ${index + 1}` : ""}
                            </p>
                            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                              Open in new tab
                              <IconExternalLink className="text-slate-400" />
                            </p>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/*
                    Production: GHL raw response (re-enable client debug=1 + ghlAccess state)
                    {locationId && workflowGhlLog && !workflowsLoading && !workflowsError && (
                      <details className="mt-3 rounded-lg border border-white/10 bg-slate-950/50 p-2 text-xs">
                        <summary className="cursor-pointer font-medium text-slate-400">Workflows — API debug</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-black/25 p-2 text-[10px] leading-relaxed text-slate-500">{JSON.stringify(workflowGhlLog, null, 2)}</pre>
                      </details>
                    )}
                  */}
                </section>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
