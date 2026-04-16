"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Script from "next/script";

/** Hide duplicate GHL heading inside the cross-origin embed (see Step 1 title). */
const GHL_EMBED_TITLE_CROP_PX = 56;

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
   * When set, the right column loads GHL funnels whose names contain this
   * substring (API lowercases for matching). Omitted on Base — no GHL lists there.
   */
  resourceSearchQuery?: string;
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

function AccordionChevron() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
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
    label: "Pain/Device",
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
  const [funnels, setFunnels] = useState<FunnelItem[]>([]);
  const [funnelsLoading, setFunnelsLoading] = useState(false);
  const [funnelsError, setFunnelsError] = useState<string | null>(null);

  const activeCampaign =
    CAMPAIGNS.find((campaign) => campaign.key === active) ?? CAMPAIGNS[0];
  const resourceQuery = activeCampaign.resourceSearchQuery;
  const showGhlResources = Boolean(resourceQuery);
  const isBase = activeCampaign.key === "base";
  const baseCampaignNav = CAMPAIGNS.find((c) => c.key === "base");
  const campaignsAfterBase = CAMPAIGNS.filter((c) => c.key !== "base");

  useEffect(() => {
    if (!resourceQuery) {
      setFunnels([]);
      setFunnelsError(null);
      setFunnelsLoading(false);
      return;
    }

    if (!locationId) {
      setFunnels([]);
      setFunnelsError(
        "No location connected for GHL lookup yet. Forms still work."
      );
      return;
    }

    const q = encodeURIComponent(resourceQuery);

    let isCancelled = false;
    const load = async () => {
      setFunnelsLoading(true);
      setFunnelsError(null);
      try {
        const funnelsRes = await fetch(
          `/api/funnels/${encodeURIComponent(locationId)}?query=${q}`,
          { cache: "no-store" }
        );

        const funnelsData = (await funnelsRes.json()) as {
          funnels?: FunnelItem[];
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
        }
      } catch (error) {
        if (!isCancelled) {
          setFunnels([]);
          setFunnelsError(
            error instanceof Error ? error.message : "Failed to load funnels"
          );
        }
      } finally {
        if (!isCancelled) setFunnelsLoading(false);
      }
    };

    void load();
    return () => {
      isCancelled = true;
    };
  }, [active, locationId, resourceQuery]);

  const step1Title = `Step 1) ${activeCampaign.label} Settings`;

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

      <div className="mx-auto max-w-5xl px-4 py-6 lg:max-w-6xl lg:px-8">
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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:items-start">
          <aside className="rounded-2xl border border-white/10 bg-slate-900/60 p-3 lg:sticky lg:top-6">
            <p className="px-2 pb-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
              Start here
            </p>
            {baseCampaignNav ? (
              <button
                type="button"
                onClick={() => setActive(baseCampaignNav.key)}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                  active === baseCampaignNav.key
                    ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                <p className="text-sm font-semibold">{baseCampaignNav.label}</p>
                <p className="text-xs text-slate-400">{baseCampaignNav.subtitle}</p>
              </button>
            ) : null}
            <p className="mt-3 px-2 pb-2 pt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
              Campaigns
            </p>
            <nav className="space-y-1">
              {campaignsAfterBase.map((campaign) => {
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

          <div className="min-w-0 space-y-3">
            <details className="group rounded-2xl border border-white/10 bg-slate-900/60 open:bg-slate-900/70">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left [&::-webkit-details-marker]:hidden">
                <span className="text-base font-semibold text-white">
                  {step1Title}
                </span>
                <AccordionChevron />
              </summary>
              <div className="border-t border-white/10 px-4 pb-4 pt-1">
                {/*
                  {activeCampaign.formName} — hidden: duplicate of Step 1 title; GHL title inside iframe is cropped below.
                */}
                <div className="rounded-xl border border-white/10 bg-slate-900 p-2">
                  <div
                    className="overflow-hidden rounded-lg"
                    style={{ height: `${activeCampaign.height}px` }}
                  >
                    <iframe
                      src={`https://link.automatedpractice.com/widget/form/${activeCampaign.formId}`}
                      style={{
                        width: "100%",
                        height: `${activeCampaign.height + GHL_EMBED_TITLE_CROP_PX}px`,
                        marginTop: `-${GHL_EMBED_TITLE_CROP_PX}px`,
                        border: "none",
                        borderRadius: "10px",
                        display: "block",
                        backgroundColor: "transparent",
                        filter:
                          "invert(1) hue-rotate(180deg) brightness(1.1) contrast(0.96)",
                        mixBlendMode: "screen",
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
                </div>
              </div>
            </details>

            {isBase ? (
              <details className="group rounded-2xl border border-white/10 bg-slate-900/60 open:bg-slate-900/70">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left [&::-webkit-details-marker]:hidden">
                  <span className="text-base font-semibold text-white">
                    Step 2) Pick Campaign(s)
                  </span>
                  <AccordionChevron />
                </summary>
                <div className="border-t border-white/10 px-4 pb-4 pt-3">
                  <p className="text-sm leading-relaxed text-slate-300">
                    Fill out your desired campaign settings by clicking one of the
                    items in the left panel under{" "}
                    <span className="font-medium text-slate-200">Campaigns</span>.
                  </p>
                </div>
              </details>
            ) : (
              <details className="group rounded-2xl border border-white/10 bg-slate-900/60 open:bg-slate-900/70">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left [&::-webkit-details-marker]:hidden">
                  <span className="text-base font-semibold text-white">
                    Step 2) Landing Page
                  </span>
                  <AccordionChevron />
                </summary>
                <div className="space-y-4 border-t border-white/10 px-4 pb-4 pt-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Instructions</p>
                    <ol className="mt-3 list-decimal space-y-6 pl-5 text-sm leading-relaxed text-slate-300">
                      <li>
                        Open your funnel in GHL using the{" "}
                        <span className="text-slate-200">Landing Page</span> link
                        below (when connected).
                      </li>
                      <li>
                        <span className="text-slate-200">Connect a domain</span> to
                        your funnel (Sites → Funnels → your funnel → domain /
                        publishing settings). Example:
                        <span className="mt-3 block overflow-hidden rounded-lg border border-white/10 bg-slate-950/50">
                          <Image
                            src="/domain.png"
                            alt="Where to connect a domain for your funnel in GHL"
                            width={960}
                            height={540}
                            className="h-auto w-full max-w-2xl"
                            sizes="(max-width: 768px) 100vw, 672px"
                          />
                        </span>
                      </li>
                      <li>Customize the page if needed.</li>
                      <li>
                        To use the page in ads: open the funnel preview, click the{" "}
                        <span className="text-slate-200">share</span> button, then{" "}
                        <span className="text-slate-200">copy the URL</span> from the
                        dialog and paste it into your ad.
                        <span className="mt-3 block overflow-hidden rounded-lg border border-white/10 bg-slate-950/50">
                          <Image
                            src="/preview.png"
                            alt="Share button and copy URL for your funnel preview"
                            width={960}
                            height={540}
                            className="h-auto w-full max-w-2xl"
                            sizes="(max-width: 768px) 100vw, 672px"
                          />
                        </span>
                      </li>
                    </ol>
                  </div>
                  {showGhlResources && (
                    <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
                      {!locationId && (
                        <p className="rounded-lg border border-amber-400/15 bg-amber-400/10 px-3 py-2 text-xs text-amber-100/90">
                          No location ID — connect GHL to load your landing page
                          link.
                        </p>
                      )}
                      {locationId && funnelsLoading && (
                        <p className="text-sm text-slate-400">Loading…</p>
                      )}
                      {locationId && funnelsError && (
                        <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/95">
                          {funnelsError}
                        </p>
                      )}
                      {locationId &&
                        !funnelsLoading &&
                        !funnelsError &&
                        funnels.length === 0 && (
                          <p className="text-sm text-slate-400">
                            No landing page found for this campaign (Spanish-only
                            matches are excluded).
                          </p>
                        )}
                      {locationId && funnels[0] && (
                        <a
                          href={funnels[0].url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 flex w-full flex-col rounded-xl border border-white/10 px-3 py-2.5 text-left transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400/50"
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
                    </div>
                  )}
                </div>
              </details>
            )}

            {/*
              Production: GHL maintenance shortcuts (uncomment if needed)
              {locationId && (
                <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-900/60 p-3">
                  <a href={`/api/auth/ghl/reauthorize?locationId=...`}>Hard Reconnect GHL</a>
                  <a href={`/api/debug/ghl-workflow-probe/...`}>Workflow API probe</a>
                </div>
              )}
            */}

            {/*
              Production: workflows (PART 1 / PART 2) — uncomment to restore
              <details className="...">
                <summary>Workflows</summary>
                ... fetch /api/workflows + list ...
              </details>
            */}
          </div>
        </div>
      </div>
    </div>
  );
}
