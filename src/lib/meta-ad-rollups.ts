export interface MetaAdPerformanceTotals {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  leads: number;
}

export interface MetaAdPerformanceMetrics extends MetaAdPerformanceTotals {
  frequency?: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
}

export interface MetaAdRollupPhrase {
  id: number;
  phrase: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAdRollupSummary extends MetaAdPerformanceMetrics {
  id: number;
  label: string;
  phrase: string;
  enabled: boolean;
  adCount: number;
}

export interface MetaAdTag {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAdTagAssignment {
  adId: string;
  tagId: number;
}

export type MetaAdTagRollupMode = "all" | "any";

export interface MetaAdTagRollupRule {
  id: number;
  name: string;
  includeMode: MetaAdTagRollupMode;
  includeTagIds: number[];
  excludeTagIds: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAdTagRollupSummary extends MetaAdPerformanceMetrics {
  id: number;
  label: string;
  name: string;
  includeMode: MetaAdTagRollupMode;
  includeTagIds: number[];
  excludeTagIds: number[];
  enabled: boolean;
  adCount: number;
}

export function buildEmptyMetaAdTotals(): MetaAdPerformanceTotals {
  return {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    inlineLinkClicks: 0,
    leads: 0,
  };
}

export function addMetaAdTotals<T extends MetaAdPerformanceTotals>(
  totals: MetaAdPerformanceTotals,
  row: T
): MetaAdPerformanceTotals {
  return {
    spend: totals.spend + row.spend,
    impressions: totals.impressions + row.impressions,
    reach: totals.reach + row.reach,
    clicks: totals.clicks + row.clicks,
    inlineLinkClicks: totals.inlineLinkClicks + row.inlineLinkClicks,
    leads: totals.leads + row.leads,
  };
}

export function deriveMetaAdMetrics(
  totals: MetaAdPerformanceTotals,
  averages?: {
    frequency?: number | null;
    ctr?: number | null;
    cpc?: number | null;
    cpm?: number | null;
    cpl?: number | null;
  }
): MetaAdPerformanceMetrics {
  return {
    ...totals,
    frequency: averages?.frequency ?? null,
    ctr:
      averages?.ctr ??
      (totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null),
    cpc: averages?.cpc ?? (totals.clicks > 0 ? totals.spend / totals.clicks : null),
    cpm:
      averages?.cpm ??
      (totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : null),
    cpl: averages?.cpl ?? (totals.leads > 0 ? totals.spend / totals.leads : null),
  };
}

function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

export function buildMetaAdRollupSummaries<
  T extends MetaAdPerformanceTotals & {
    adName: string;
    frequency?: number | null;
    ctr?: number | null;
    cpc?: number | null;
    cpm?: number | null;
    cpl?: number | null;
  },
>(rows: T[], phrases: MetaAdRollupPhrase[]): MetaAdRollupSummary[] {
  return phrases.map((phrase) => {
    const needle = phrase.phrase.trim().toLowerCase();
    const matchedRows =
      phrase.enabled && needle
        ? rows.filter((row) => row.adName.toLowerCase().includes(needle))
        : [];
    let totals = buildEmptyMetaAdTotals();
    for (const row of matchedRows) {
      totals = addMetaAdTotals(totals, row);
    }
    return {
      id: phrase.id,
      label: phrase.phrase,
      phrase: phrase.phrase,
      enabled: phrase.enabled,
      adCount: matchedRows.length,
      ...deriveMetaAdMetrics(totals, {
        frequency: average(matchedRows.map((row) => row.frequency)),
        ctr: average(matchedRows.map((row) => row.ctr)),
        cpc: average(matchedRows.map((row) => row.cpc)),
        cpm: average(matchedRows.map((row) => row.cpm)),
        cpl: average(matchedRows.map((row) => row.cpl)),
      }),
    };
  });
}

export function buildMetaAdTagRollupSummaries<
  T extends MetaAdPerformanceTotals & {
    adId: string;
    frequency?: number | null;
    ctr?: number | null;
    cpc?: number | null;
    cpm?: number | null;
    cpl?: number | null;
  },
>(
  rows: T[],
  rules: MetaAdTagRollupRule[],
  assignments: MetaAdTagAssignment[]
): MetaAdTagRollupSummary[] {
  const tagIdsByAd = new Map<string, Set<number>>();
  for (const assignment of assignments) {
    const set = tagIdsByAd.get(assignment.adId) ?? new Set<number>();
    set.add(assignment.tagId);
    tagIdsByAd.set(assignment.adId, set);
  }

  return rules.map((rule) => {
    const includeTagIds = Array.from(new Set(rule.includeTagIds));
    const excludeTagIds = Array.from(new Set(rule.excludeTagIds));
    const matchedRows =
      rule.enabled && includeTagIds.length > 0
        ? rows.filter((row) => {
            const rowTagIds = tagIdsByAd.get(row.adId) ?? new Set<number>();
            const hasIncluded =
              rule.includeMode === "all"
                ? includeTagIds.every((tagId) => rowTagIds.has(tagId))
                : includeTagIds.some((tagId) => rowTagIds.has(tagId));
            const hasExcluded = excludeTagIds.some((tagId) => rowTagIds.has(tagId));
            return hasIncluded && !hasExcluded;
          })
        : [];
    let totals = buildEmptyMetaAdTotals();
    for (const row of matchedRows) {
      totals = addMetaAdTotals(totals, row);
    }
    return {
      id: rule.id,
      label: rule.name,
      name: rule.name,
      includeMode: rule.includeMode,
      includeTagIds,
      excludeTagIds,
      enabled: rule.enabled,
      adCount: matchedRows.length,
      ...deriveMetaAdMetrics(totals, {
        frequency: average(matchedRows.map((row) => row.frequency)),
        ctr: average(matchedRows.map((row) => row.ctr)),
        cpc: average(matchedRows.map((row) => row.cpc)),
        cpm: average(matchedRows.map((row) => row.cpm)),
        cpl: average(matchedRows.map((row) => row.cpl)),
      }),
    };
  });
}
