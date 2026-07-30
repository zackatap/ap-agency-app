/**
 * Meta ad spend for Internal Sales (AP MASTER account).
 *
 * Default ad account: Client DB CID 0 / Internal — Automated Practice
 *   257686200345301
 *
 * Override with INTERNAL_SALES_AD_ACCOUNT_ID.
 */

import {
  fetchAdInsights,
  fetchSpendByMonth,
  normalizeAdAccountId,
  type MetaAdInsight,
} from "@/lib/facebook-ads";
import {
  BLANK_ATTR,
  hasAttributionFilters,
  type AttributionDimension,
  type AttributionFilters,
} from "@/lib/internal-sales-metrics";

const DEFAULT_AD_ACCOUNT_ID = "257686200345301";

export function getInternalSalesAdAccountId(): string {
  const raw =
    process.env.INTERNAL_SALES_AD_ACCOUNT_ID?.trim() || DEFAULT_AD_ACCOUNT_ID;
  return normalizeAdAccountId(raw);
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function costPer(spend: number, count: number): number | null {
  if (spend <= 0 || count <= 0) return null;
  return money(spend / count);
}

function normalizeName(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Pull a leading Meta object ID from values like "1202… (Hook name)". */
function extractId(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === BLANK_ATTR) return null;
  if (/^\d{8,}$/.test(s)) return s;
  const m = s.match(/^(\d{8,})\s*(?:\(|$)/);
  return m?.[1] ?? null;
}

function nameFromToken(raw: string): string {
  const s = raw.trim();
  if (!s || s === BLANK_ATTR) return "";
  const paren = s.match(/^\d{8,}\s*\((.+)\)\s*$/);
  if (paren?.[1]) return normalizeName(paren[1]);
  const stripped = s.replace(/^\d{8,}\s+/, "");
  return normalizeName(stripped);
}

function tokenMatchesOne(
  token: string,
  metaId: string | null | undefined,
  metaName: string | null | undefined
): boolean {
  if (token === BLANK_ATTR) {
    return !metaId && !normalizeName(metaName ?? "");
  }
  const id = extractId(token);
  if (id && metaId && id === metaId) return true;
  const want = nameFromToken(token);
  const have = normalizeName(metaName ?? "");
  if (!want || !have) return false;
  return have === want || have.includes(want) || want.includes(have);
}

/** Empty selection = match all. Otherwise OR across selected tokens. */
function tokensMatchAny(
  tokens: string[] | undefined,
  metaId: string | null | undefined,
  metaName: string | null | undefined
): boolean {
  if (!tokens?.length) return true;
  return tokens.some((t) => tokenMatchesOne(t, metaId, metaName));
}

export function insightMatchesFilters(
  ad: MetaAdInsight,
  filters: AttributionFilters
): boolean {
  return (
    tokensMatchAny(filters.campaigns, ad.campaignId, ad.campaignName) &&
    tokensMatchAny(filters.adSets, ad.adsetId, ad.adsetName) &&
    tokensMatchAny(filters.ads, ad.adId, ad.adName)
  );
}

export function sumInsightSpend(ads: MetaAdInsight[]): number {
  return money(ads.reduce((acc, a) => acc + (a.spend || 0), 0));
}

export interface SpendCosts {
  spend: number;
  cpl: number | null;
  cps: number | null;
  cpClose: number | null;
}

export function costsFromSpend(
  spend: number,
  counts: { leads: number; showed: number; signed: number }
): SpendCosts {
  return {
    spend: money(spend),
    cpl: costPer(spend, counts.leads),
    cps: costPer(spend, counts.showed),
    cpClose: costPer(spend, counts.signed),
  };
}

export async function fetchFilteredAdInsights(
  since: string,
  until: string,
  filters: AttributionFilters = {}
): Promise<{ ads: MetaAdInsight[]; error?: string; adAccountId: string }> {
  const adAccountId = getInternalSalesAdAccountId();
  const { ads, error } = await fetchAdInsights(adAccountId, since, until);
  if (error) return { ads: [], error, adAccountId };
  const filtered = ads.filter((a) => insightMatchesFilters(a, filters));
  return { ads: filtered, adAccountId };
}

/**
 * Match a By-ad breakdown row key to Meta insights and sum spend.
 * Prefers ID match, then name.
 */
export function spendForBreakdownKey(
  ads: MetaAdInsight[],
  dimension: AttributionDimension,
  key: string
): number | null {
  if (dimension === "source") return null;
  if (!key) return null;

  let total = 0;
  let any = false;

  for (const ad of ads) {
    let metaId: string | null = null;
    let metaName: string | null = null;
    if (dimension === "ad") {
      metaId = ad.adId;
      metaName = ad.adName;
    } else if (dimension === "adSet") {
      metaId = ad.adsetId;
      metaName = ad.adsetName;
    } else if (dimension === "campaign") {
      metaId = ad.campaignId;
      metaName = ad.campaignName;
    }
    if (tokenMatchesOne(key, metaId, metaName)) {
      total += ad.spend || 0;
      any = true;
    }
  }

  return any ? money(total) : null;
}

/**
 * Account-level monthly spend. When attribution filters are set, fetches
 * ad insights per month and sums matching ads (slower but accurate).
 */
export async function fetchMonthlySpend(
  monthKeys: string[],
  filters: AttributionFilters = {}
): Promise<{
  spendByMonth: Record<string, number>;
  error?: string;
  adAccountId: string;
}> {
  const adAccountId = getInternalSalesAdAccountId();
  const hasFilters = hasAttributionFilters(filters);

  if (!hasFilters) {
    const { spendByMonth, error } = await fetchSpendByMonth(
      adAccountId,
      false,
      monthKeys
    );
    return { spendByMonth, error, adAccountId };
  }

  const spendByMonth: Record<string, number> = {};
  for (const k of monthKeys) spendByMonth[k] = 0;

  // Parallel month fetches — 13 months max for the dashboard.
  const results = await Promise.all(
    monthKeys.map(async (monthKey) => {
      const [y, m] = monthKey.split("-").map(Number);
      const since = `${monthKey}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const until = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
      const { ads, error } = await fetchFilteredAdInsights(since, until, filters);
      return { monthKey, spend: sumInsightSpend(ads), error };
    })
  );

  let firstError: string | undefined;
  for (const r of results) {
    spendByMonth[r.monthKey] = r.spend;
    if (r.error && !firstError) firstError = r.error;
  }

  return { spendByMonth, error: firstError, adAccountId };
}
