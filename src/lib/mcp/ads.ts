/**
 * Live Meta ad-level performance for a single client, built for the Gleap MCP
 * server. This is the input for "recommend actionable changes to their ads":
 * it pulls per-ad spend, leads, CPL, CTR, and frequency straight from the Graph
 * API (live, not the snapshot) so the agent can name specific winning and
 * losing ads.
 *
 * Resolves the client's ad account + Meta campaign keyword from the roster,
 * lists the account's campaigns, keeps those whose name contains the keyword
 * (same substring logic the rollup runner uses), then fetches ad insights
 * filtered to those campaign IDs.
 */

import {
  fetchCampaigns,
  fetchAdInsights,
  type MetaAdInsight,
} from "@/lib/facebook-ads";
import {
  getDateRangeForPreset,
  DATE_RANGE_LABELS,
  type DateRangePreset,
} from "@/lib/date-ranges";
import { resolveSingleClient, type ResolvedClient } from "@/lib/mcp/resolve-client";

export type AdPreset = "last_7" | "last_14" | "last_30" | "last_60" | "last_90";

export interface AdRow {
  adId: string;
  adName: string;
  campaignName: string | null;
  spend: number;
  leads: number;
  cpl: number | null;
  ctr: number | null;
  cpc: number | null;
  frequency: number | null;
  impressions: number;
  linkClicks: number;
}

export interface AdPerformance {
  status: "ok";
  client: { locationId: string; businessName: string; adAccountId: string };
  window: { preset: string; label: string; startDate: string; endDate: string };
  campaignKeyword: string | null;
  matchedCampaigns: number;
  totals: { spend: number; leads: number; cpl: number | null; activeAds: number };
  /** Ads sorted by spend, descending. */
  ads: AdRow[];
  topPerformers: AdRow[];
  underperformers: AdRow[];
  findings: string[];
}

export type AdResult =
  | AdPerformance
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; matches: Array<{ locationId: string; businessName: string }> }
  | { status: "no_ad_account" }
  | { status: "meta_error"; message: string };

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function toAdRow(a: MetaAdInsight): AdRow {
  return {
    adId: a.adId,
    adName: a.adName,
    campaignName: a.campaignName,
    spend: round2(a.spend),
    leads: a.leads,
    cpl: a.leads > 0 ? round2(a.spend / a.leads) : null,
    ctr: a.ctr,
    cpc: a.cpc,
    frequency: a.frequency,
    impressions: a.impressions,
    linkClicks: a.inlineLinkClicks,
  };
}

/**
 * Live ad-level breakdown for the best client match of `query` over `preset`
 * (default last_30). Restricts to the client's keyword-matched campaigns when a
 * keyword is configured; otherwise reports the whole ad account.
 */
export async function getAdPerformance(params: {
  query: string;
  preset?: AdPreset;
}): Promise<AdResult> {
  const preset = params.preset ?? "last_30";

  const resolved = await resolveSingleClient(params.query);
  if (resolved.status === "not_found") return { status: "not_found", query: params.query };
  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: resolved.matches.map((m) => ({ locationId: m.locationId, businessName: m.businessName })),
    };
  }
  const client: ResolvedClient = resolved.client;

  const adAccountId = client.adAccountIds[0];
  if (!adAccountId) return { status: "no_ad_account" };

  const range = getDateRangeForPreset(preset as DateRangePreset);
  const label = DATE_RANGE_LABELS[preset as DateRangePreset] ?? preset;
  const keyword = client.campaignKeywords[0] ?? null;

  // Resolve keyword → campaign IDs (substring match on campaign name).
  let campaignIds: string[] | undefined;
  let matchedCampaigns = 0;
  if (keyword) {
    const { campaigns, error } = await fetchCampaigns(adAccountId);
    if (error) return { status: "meta_error", message: error };
    const kw = keyword.toLowerCase();
    const matched = campaigns.filter((c) => c.name.toLowerCase().includes(kw));
    matchedCampaigns = matched.length;
    campaignIds = matched.map((c) => c.id);
    // Keyword configured but nothing matched: report explicitly rather than
    // silently pulling the entire account.
    if (campaignIds.length === 0) {
      return {
        status: "ok",
        client: { locationId: client.locationId, businessName: client.businessName, adAccountId },
        window: { preset, label, startDate: range.startDate, endDate: range.endDate },
        campaignKeyword: keyword,
        matchedCampaigns: 0,
        totals: { spend: 0, leads: 0, cpl: null, activeAds: 0 },
        ads: [],
        topPerformers: [],
        underperformers: [],
        findings: [
          `No Meta campaigns matched the keyword "${keyword}" in account ${adAccountId}. The campaign may be renamed, paused, or the keyword needs updating.`,
        ],
      };
    }
  }

  const { ads: rawAds, error } = await fetchAdInsights(
    adAccountId,
    range.startDate,
    range.endDate,
    campaignIds ? { campaignIds } : undefined
  );
  if (error && rawAds.length === 0) return { status: "meta_error", message: error };

  const ads = rawAds
    .map(toAdRow)
    .filter((a) => a.spend > 0 || a.leads > 0)
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = round2(ads.reduce((s, a) => s + a.spend, 0));
  const totalLeads = ads.reduce((s, a) => s + a.leads, 0);
  const totals = {
    spend: totalSpend,
    leads: totalLeads,
    cpl: totalLeads > 0 ? round2(totalSpend / totalLeads) : null,
    activeAds: ads.length,
  };

  // Top = best CPL among ads with leads. Under = spend but no leads, or worst CPL.
  const withLeads = ads.filter((a) => a.leads > 0 && a.cpl != null);
  const topPerformers = [...withLeads].sort((a, b) => (a.cpl! - b.cpl!)).slice(0, 3);
  const noLeadSpenders = ads.filter((a) => a.leads === 0 && a.spend > 0).sort((a, b) => b.spend - a.spend);
  const worstCpl = [...withLeads].sort((a, b) => b.cpl! - a.cpl!);
  const underperformers = [...noLeadSpenders, ...worstCpl].slice(0, 3);

  const findings = buildAdFindings({ totals, topPerformers, underperformers, noLeadSpenders });

  return {
    status: "ok",
    client: { locationId: client.locationId, businessName: client.businessName, adAccountId },
    window: { preset, label, startDate: range.startDate, endDate: range.endDate },
    campaignKeyword: keyword,
    matchedCampaigns,
    totals,
    ads,
    topPerformers,
    underperformers,
    findings,
  };
}

function fmtMoney(v: number | null): string {
  return v == null ? "n/a" : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function buildAdFindings(args: {
  totals: AdPerformance["totals"];
  topPerformers: AdRow[];
  underperformers: AdRow[];
  noLeadSpenders: AdRow[];
}): string[] {
  const { totals, topPerformers, underperformers, noLeadSpenders } = args;
  const out: string[] = [];

  if (totals.activeAds === 0) {
    out.push("No ads with spend or leads in this window.");
    return out;
  }

  out.push(
    `${totals.activeAds} active ads spent ${fmtMoney(totals.spend)} for ${totals.leads} leads (account CPL ${fmtMoney(totals.cpl)}).`
  );

  if (topPerformers.length) {
    const best = topPerformers[0];
    out.push(`Best performer: "${best.adName}" at ${fmtMoney(best.cpl)} CPL (${best.leads} leads, ${fmtMoney(best.spend)} spend). Consider scaling it.`);
  }

  const deadSpend = round2(noLeadSpenders.reduce((s, a) => s + a.spend, 0));
  if (noLeadSpenders.length && deadSpend > 0) {
    out.push(
      `${noLeadSpenders.length} ad(s) spent ${fmtMoney(deadSpend)} with zero leads — candidates to pause or refresh creative.`
    );
  }

  const worst = underperformers.find((a) => a.cpl != null);
  if (worst && topPerformers[0]?.cpl != null && worst.cpl! > topPerformers[0].cpl * 2) {
    out.push(`"${worst.adName}" is converting at ${fmtMoney(worst.cpl)} CPL, well above the best ad — shift budget toward winners.`);
  }

  // Creative fatigue hint via frequency.
  const fatigued = [...topPerformers, ...underperformers].find(
    (a) => a.frequency != null && a.frequency >= 3
  );
  if (fatigued) {
    out.push(`"${fatigued.adName}" has a frequency of ${fatigued.frequency?.toFixed(1)} — audience fatigue is likely; refresh the creative.`);
  }

  return out;
}
