"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATE_RANGE_LABELS,
  getTodayLocal,
  type DateRangePreset,
} from "@/lib/date-ranges";
import {
  formatCount,
  formatDateTime,
  formatMoney,
  formatMoneyDecimal,
  formatPercent,
} from "./format";

const DATE_RANGE_ORDER: DateRangePreset[] = [
  "this_month",
  "last_month",
  "last_30",
  "last_60",
  "last_90",
  "maximum",
  "custom",
];

const ADS_DATE_RANGE_STORAGE_KEY = "agency-meta-ads-date-range";

type SortKey =
  | "spend"
  | "impressions"
  | "reach"
  | "clicks"
  | "inlineLinkClicks"
  | "ctr"
  | "cpc"
  | "cpm"
  | "leads"
  | "cpl"
  | "adName"
  | "businessName"
  | "campaignName";

interface MetaAdsRange {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
  label: string;
}

interface MetaAdsMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inlineLinkClicks: number;
  leads: number;
  frequency?: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpl: number | null;
}

interface MetaAdsPhrase {
  id: number;
  phrase: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MetaAdsRollup extends MetaAdsMetrics {
  id: number;
  label: string;
  phrase: string;
  enabled: boolean;
  adCount: number;
}

interface MetaAdsTag {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface MetaAdsTagAssignment {
  adId: string;
  tagId: number;
}

interface MetaAdsTagRollup extends MetaAdsMetrics {
  id: number;
  label: string;
  name: string;
  includeMode: "all" | "any";
  includeTagIds: number[];
  excludeTagIds: number[];
  enabled: boolean;
  adCount: number;
}

interface MetaAdsTagRollupRule {
  id: number;
  name: string;
  includeMode: "all" | "any";
  includeTagIds: number[];
  excludeTagIds: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MetaAdsRow extends MetaAdsMetrics {
  rowKey: string;
  adId: string;
  adName: string;
  adsetName: string | null;
  campaignName: string | null;
  thumbnailUrl: string | null;
  adsManagerUrl: string | null;
  locationId: string;
  campaignKey: string;
  cid: string | null;
  businessName: string;
  ownerName: string | null;
  status: "ACTIVE" | "2ND CMPN";
  pipelineKeyword: string | null;
  campaignKeyword: string | null;
  adAccountId: string;
}

type AdsTableRow =
  | ({
      rowType: "rollup";
      rollupKind: "phrase";
      children: AdTableRow[];
    } & MetaAdsRollup)
  | ({
      rowType: "rollup";
      rollupKind: "tag";
      children: AdTableRow[];
    } & MetaAdsTagRollup)
  | AdTableRow;

type AdTableRow = {
  rowType: "ad";
  matchingRollups: MetaAdsRollup[];
  matchingTagRollups: MetaAdsTagRollup[];
  tags: MetaAdsTag[];
} & MetaAdsRow;

interface MetaAdsResponse {
  snapshot?: { id: number } | null;
  cached: boolean;
  range?: MetaAdsRange;
  recentSpendMonths?: number;
  accountCount?: number;
  eligibleAccountCount?: number;
  sheetCampaignCount?: number;
  eligibleCampaignCount?: number;
  rowCount?: number;
  refreshedAt?: string;
  totals?: MetaAdsMetrics;
  phrases: MetaAdsPhrase[];
  tags: MetaAdsTag[];
  tagRollupRules: MetaAdsTagRollupRule[];
  tagAssignments: MetaAdsTagAssignment[];
  rollups: MetaAdsRollup[];
  tagRollups: MetaAdsTagRollup[];
  rows: MetaAdsRow[];
  warnings?: Array<{
    adAccountId?: string;
    campaignKey?: string;
    message: string;
  }>;
  error?: string;
}

interface ThumbnailMatchGroup {
  id: string;
  matchType: "exact" | "similar";
  label: string;
  representativeThumbnailUrl: string;
  maxDistance: number;
  ads: Array<{
    adId: string;
    adName: string;
    thumbnailUrl: string;
    adsManagerUrl?: string | null;
    businessName?: string;
    spend?: number;
  }>;
}

interface SelectedTagSummary {
  tag: MetaAdsTag;
  count: number;
}

interface AppliedRange {
  preset: DateRangePreset;
  from: string;
  to: string;
}

function readStoredAdsRange(): AppliedRange {
  const fallback: AppliedRange = { preset: "last_30", from: "", to: "" };
  if (typeof window === "undefined") return fallback;

  try {
    const stored = window.localStorage.getItem(ADS_DATE_RANGE_STORAGE_KEY);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<AppliedRange>;
    if (!parsed.preset || !DATE_RANGE_ORDER.includes(parsed.preset)) return fallback;
    return {
      preset: parsed.preset,
      from: typeof parsed.from === "string" ? parsed.from : "",
      to: typeof parsed.to === "string" ? parsed.to : "",
    };
  } catch {
    return fallback;
  }
}

function writeStoredAdsRange(range: AppliedRange) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADS_DATE_RANGE_STORAGE_KEY, JSON.stringify(range));
}

const SORT_LABELS: Record<SortKey, string> = {
  spend: "Spend",
  impressions: "Impr.",
  reach: "Reach",
  clicks: "Clicks",
  inlineLinkClicks: "Link clicks",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  leads: "Leads",
  cpl: "CPL",
  adName: "Ad",
  businessName: "Client",
  campaignName: "Campaign",
};

const TAG_COLOR_CLASSES = [
  "border-sky-400/30 bg-sky-500/15 text-sky-100",
  "border-emerald-400/30 bg-emerald-500/15 text-emerald-100",
  "border-violet-400/30 bg-violet-500/15 text-violet-100",
  "border-amber-400/30 bg-amber-500/15 text-amber-100",
  "border-rose-400/30 bg-rose-500/15 text-rose-100",
  "border-cyan-400/30 bg-cyan-500/15 text-cyan-100",
  "border-lime-400/30 bg-lime-500/15 text-lime-100",
  "border-fuchsia-400/30 bg-fuchsia-500/15 text-fuchsia-100",
];

export function MetaAdsTab() {
  const [initialRange] = useState(readStoredAdsRange);
  const [dateRangePreset, setDateRangePreset] =
    useState<DateRangePreset>(initialRange.preset);
  const [customDateFrom, setCustomDateFrom] = useState(initialRange.from);
  const [customDateTo, setCustomDateTo] = useState(initialRange.to);
  const [appliedRange, setAppliedRange] = useState<AppliedRange>(initialRange);
  const [data, setData] = useState<MetaAdsResponse | null>(null);
  const [loadingCache, setLoadingCache] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingRollup, setSavingRollup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newPhrase, setNewPhrase] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [bulkTagId, setBulkTagId] = useState("");
  const [newTagRollupName, setNewTagRollupName] = useState("");
  const [tagRollupIncludeMode, setTagRollupIncludeMode] = useState<"all" | "any">(
    "all"
  );
  const [tagRollupIncludeIds, setTagRollupIncludeIds] = useState<string[]>([]);
  const [tagRollupExcludeIds, setTagRollupExcludeIds] = useState<string[]>([]);
  const [thumbnailThreshold, setThumbnailThreshold] = useState("8");
  const [thumbnailGroups, setThumbnailGroups] = useState<ThumbnailMatchGroup[]>([]);
  const [activeThumbnailGroupId, setActiveThumbnailGroupId] = useState<string | null>(
    null
  );
  const [matchingThumbnails, setMatchingThumbnails] = useState(false);
  const [thumbnailMatchError, setThumbnailMatchError] = useState<string | null>(null);
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [showUntaggedOnly, setShowUntaggedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRollups, setExpandedRollups] = useState<Set<string>>(new Set());
  const tableHeaderScrollRef = useRef<HTMLDivElement | null>(null);
  const tableBodyScrollRef = useRef<HTMLDivElement | null>(null);

  const requestAds = useCallback(
    (range: AppliedRange, method: "GET" | "POST", signal?: AbortSignal) => {
      const params = new URLSearchParams({
        preset: range.preset,
        clientDate: getTodayLocal(),
      });
      if (range.preset === "custom") {
        params.set("from", range.from);
        params.set("to", range.to);
      }

      if (method === "POST") setRefreshing(true);
      else setLoadingCache(true);
      setError(null);

      fetch(`/api/agency/meta/ads?${params.toString()}`, {
        method,
        cache: "no-store",
        signal,
      })
        .then(async (res) => {
          const json = (await res.json()) as MetaAdsResponse;
          if (!res.ok) {
            throw new Error(json.error ?? "Failed to load Meta ads");
          }
          setData(json);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Meta ads");
        })
        .finally(() => {
          if (signal?.aborted) return;
          if (method === "POST") setRefreshing(false);
          else setLoadingCache(false);
        });
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    const id = window.setTimeout(() => {
      requestAds(appliedRange, "GET", controller.signal);
    }, 0);

    return () => {
      window.clearTimeout(id);
      controller.abort();
    };
  }, [appliedRange, requestAds]);

  const allAdTableRows = useMemo<AdTableRow[]>(() => {
    const activeRollups = data?.rollups.filter((rollup) => rollup.enabled) ?? [];
    const activeTagRollups = data?.tagRollups.filter((rollup) => rollup.enabled) ?? [];
    const tagsById = new Map((data?.tags ?? []).map((tag) => [tag.id, tag]));
    const tagIdsByAd = new Map<string, Set<number>>();
    for (const assignment of data?.tagAssignments ?? []) {
      const set = tagIdsByAd.get(assignment.adId) ?? new Set<number>();
      set.add(assignment.tagId);
      tagIdsByAd.set(assignment.adId, set);
    }
    return (
      data?.rows.map((row) => ({
        ...row,
        rowType: "ad" as const,
        matchingRollups: activeRollups.filter((rollup) =>
          row.adName.toLowerCase().includes(rollup.phrase.toLowerCase())
        ),
        matchingTagRollups: activeTagRollups.filter((rollup) => {
          const rowTagIds = tagIdsByAd.get(row.adId) ?? new Set<number>();
          const hasIncluded =
            rollup.includeMode === "all"
              ? rollup.includeTagIds.every((tagId) => rowTagIds.has(tagId))
              : rollup.includeTagIds.some((tagId) => rowTagIds.has(tagId));
          const hasExcluded = rollup.excludeTagIds.some((tagId) =>
            rowTagIds.has(tagId)
          );
          return hasIncluded && !hasExcluded;
        }),
        tags: Array.from(tagIdsByAd.get(row.adId) ?? [])
          .map((tagId) => tagsById.get(tagId))
          .filter((tag): tag is MetaAdsTag => Boolean(tag)),
      })) ?? []
    );
  }, [data?.rollups, data?.rows, data?.tagAssignments, data?.tagRollups, data?.tags]);

  const tableRows = useMemo<AdsTableRow[]>(() => {
    const activeRollups = data?.rollups.filter((rollup) => rollup.enabled) ?? [];
    const activeTagRollups = data?.tagRollups.filter((rollup) => rollup.enabled) ?? [];
    const rollupRows: AdsTableRow[] =
      activeRollups.map((rollup) => ({
        ...rollup,
        rowType: "rollup" as const,
        rollupKind: "phrase" as const,
        children: allAdTableRows.filter((row) =>
          row.matchingRollups.some((match) => match.id === rollup.id)
        ),
      })) ?? [];
    const tagRollupRows: AdsTableRow[] =
      activeTagRollups.map((rollup) => ({
        ...rollup,
        rowType: "rollup" as const,
        rollupKind: "tag" as const,
        children: allAdTableRows.filter((row) =>
          row.matchingTagRollups.some((match) => match.id === rollup.id)
        ),
      })) ?? [];
    const ungroupedAdRows: AdsTableRow[] =
      allAdTableRows
        .filter(
          (row) =>
            row.matchingRollups.length === 0 && row.matchingTagRollups.length === 0
        )
        .map((row) => ({
          ...row,
          rowType: "ad" as const,
        }));
    return [...tagRollupRows, ...rollupRows, ...ungroupedAdRows];
  }, [allAdTableRows, data?.rollups, data?.tagRollups]);

  const filteredRows = useMemo(() => {
    const query = normalizeSearch(search);
    const baseRows: AdsTableRow[] = showUntaggedOnly
      ? allAdTableRows.filter((row) => row.tags.length === 0)
      : tableRows;
    return baseRows
      .filter((row) => {
        if (!query) return true;
        if (row.rowType === "rollup") {
          const label = row.rollupKind === "tag" ? row.name : row.phrase;
          return (
            normalizeSearch(label).includes(query) ||
            row.children.some((child) => adMatchesQuery(child, query))
          );
        }
        return adMatchesQuery(row, query);
      })
      .sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [allAdTableRows, search, showUntaggedOnly, sortDir, sortKey, tableRows]);

  const visibleAdIds = useMemo(() => {
    const ids: string[] = [];
    for (const row of filteredRows) {
      if (row.rowType === "ad") {
        ids.push(row.adId);
        continue;
      }
      const rollupKey = `${row.rollupKind}:${row.id}`;
      if (!expandedRollups.has(rollupKey)) continue;
      ids.push(...row.children.map((child) => child.adId));
    }
    return Array.from(new Set(ids));
  }, [expandedRollups, filteredRows]);

  const hasCache = Boolean(data?.cached && data.rows.length > 0);
  const activePhrases = data?.phrases.filter((p) => p.enabled).length ?? 0;
  const activeTagRules = data?.tagRollupRules.filter((rule) => rule.enabled).length ?? 0;
  const groupedAdCount = useMemo(() => {
    const ids = new Set<string>();
    for (const row of tableRows) {
      if (row.rowType !== "rollup") continue;
      for (const child of row.children) ids.add(child.rowKey);
    }
    return ids.size;
  }, [tableRows]);
  const selectedCount = selectedAdIds.size;
  const selectedTagSummary = useMemo<SelectedTagSummary[]>(() => {
    if (selectedAdIds.size === 0) return [];
    const counts = new Map<number, { tag: MetaAdsTag; count: number }>();
    for (const row of allAdTableRows) {
      if (!selectedAdIds.has(row.adId)) continue;
      for (const tag of row.tags) {
        const current = counts.get(tag.id) ?? { tag, count: 0 };
        current.count += 1;
        counts.set(tag.id, current);
      }
    }
    return Array.from(counts.values()).sort(
      (a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name)
    );
  }, [allAdTableRows, selectedAdIds]);
  const untaggedAdRows = useMemo(
    () => allAdTableRows.filter((row) => row.tags.length === 0),
    [allAdTableRows]
  );
  const visibleSelectedCount = visibleAdIds.filter((adId) =>
    selectedAdIds.has(adId)
  ).length;
  const allVisibleSelected =
    visibleAdIds.length > 0 && visibleSelectedCount === visibleAdIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const untaggedCount = untaggedAdRows.length;
  const loading = loadingCache || refreshing;
  const currentRangeLabel = data?.range
    ? `${data.range.startDate} -> ${data.range.endDate}`
    : DATE_RANGE_LABELS[appliedRange.preset];

  function handleDateRangeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const preset = e.target.value as DateRangePreset;
    setDateRangePreset(preset);
    if (preset !== "custom") {
      const nextRange = { preset, from: "", to: "" };
      setAppliedRange(nextRange);
      writeStoredAdsRange(nextRange);
    }
  }

  function handleCustomDateApply() {
    if (!customDateFrom || !customDateTo) return;
    const nextRange = {
      preset: "custom",
      from: customDateFrom,
      to: customDateTo,
    } satisfies AppliedRange;
    setAppliedRange(nextRange);
    writeStoredAdsRange(nextRange);
  }

  function handleRefresh() {
    requestAds(appliedRange, "POST");
  }

  function syncTableScroll(source: "header" | "body") {
    const from =
      source === "header" ? tableHeaderScrollRef.current : tableBodyScrollRef.current;
    const to =
      source === "header" ? tableBodyScrollRef.current : tableHeaderScrollRef.current;
    if (!from || !to || to.scrollLeft === from.scrollLeft) return;
    to.scrollLeft = from.scrollLeft;
  }

  async function reloadCacheAfterRollupChange() {
    requestAds(appliedRange, "GET");
  }

  async function handleAddPhrase() {
    const phrase = newPhrase.trim();
    if (!phrase) return;
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/ad-rollups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to add rollup");
      setNewPhrase("");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleTogglePhrase(phrase: MetaAdsPhrase) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/ad-rollups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: phrase.id, enabled: !phrase.enabled }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to update rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleDeletePhrase(phrase: MetaAdsPhrase) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch(`/api/agency/meta/ad-rollups?id=${phrase.id}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to delete rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setSortDir("desc");
  }

  function toggleRollup(key: string) {
    setExpandedRollups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAdSelection(adId: string) {
    setSelectedAdIds((prev) => {
      const next = new Set(prev);
      if (next.has(adId)) next.delete(adId);
      else next.add(adId);
      return next;
    });
  }

  function toggleManyAds(adIds: string[]) {
    setSelectedAdIds((prev) => {
      const next = new Set(prev);
      const allSelected = adIds.every((adId) => next.has(adId));
      for (const adId of adIds) {
        if (allSelected) next.delete(adId);
        else next.add(adId);
      }
      return next;
    });
  }

  function toggleVisibleAds() {
    if (visibleAdIds.length === 0) return;
    toggleManyAds(visibleAdIds);
  }

  async function handleAddTag() {
    const name = newTagName.trim();
    if (!name) return;
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { tag?: MetaAdsTag; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to create tag");
      if (json.tag && selectedAdIds.size > 0) {
        const assignRes = await fetch("/api/agency/meta/tag-assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adIds: Array.from(selectedAdIds),
            tagIds: [json.tag.id],
          }),
        });
        const assignJson = (await assignRes.json()) as { error?: string };
        if (!assignRes.ok) {
          throw new Error(assignJson.error ?? "Failed to assign new tag");
        }
      }
      setNewTagName("");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tag");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleApplyTagToSelected() {
    const tagId = Number(bulkTagId);
    if (!Number.isFinite(tagId) || selectedAdIds.size === 0) return;
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/tag-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adIds: Array.from(selectedAdIds),
          tagIds: [tagId],
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to assign tag");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign tag");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleFindThumbnailGroups() {
    setMatchingThumbnails(true);
    setThumbnailMatchError(null);
    try {
      const res = await fetch("/api/agency/meta/thumbnail-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold: Number(thumbnailThreshold),
          rows: untaggedAdRows.map((row) => ({
            adId: row.adId,
            adName: row.adName,
            thumbnailUrl: row.thumbnailUrl,
            adsManagerUrl: row.adsManagerUrl,
            businessName: row.businessName,
            spend: row.spend,
          })),
        }),
      });
      const json = (await res.json()) as {
        groups?: ThumbnailMatchGroup[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Failed to match thumbnails");
      setThumbnailGroups(json.groups ?? []);
      setActiveThumbnailGroupId(null);
    } catch (err) {
      setThumbnailMatchError(
        err instanceof Error ? err.message : "Failed to match thumbnails"
      );
    } finally {
      setMatchingThumbnails(false);
    }
  }

  function selectThumbnailGroup(group: ThumbnailMatchGroup) {
    const allSelected = group.ads.every((ad) => selectedAdIds.has(ad.adId));
    toggleManyAds(group.ads.map((ad) => ad.adId));
    setActiveThumbnailGroupId(allSelected ? null : group.id);
  }

  async function handleRemoveTagFromAd(adId: string, tagId: number) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/tag-assignments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adIds: [adId], tagIds: [tagId] }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to remove tag");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove tag");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleAddTagRollup() {
    const name = newTagRollupName.trim();
    const includeTagIds = tagRollupIncludeIds.map(Number).filter(Number.isFinite);
    const excludeTagIds = tagRollupExcludeIds.map(Number).filter(Number.isFinite);
    if (!name || includeTagIds.length === 0) return;
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/tag-rollups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          includeMode: tagRollupIncludeMode,
          includeTagIds,
          excludeTagIds,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to create tag rollup");
      setNewTagRollupName("");
      setTagRollupIncludeIds([]);
      setTagRollupExcludeIds([]);
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tag rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleToggleTagRollup(rule: MetaAdsTagRollupRule) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/meta/tag-rollups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to update tag rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tag rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  async function handleDeleteTagRollup(rule: MetaAdsTagRollupRule) {
    setSavingRollup(true);
    setError(null);
    try {
      const res = await fetch(`/api/agency/meta/tag-rollups?id=${rule.id}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to delete tag rollup");
      await reloadCacheAfterRollupChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tag rollup");
    } finally {
      setSavingRollup(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-2xl border border-white/10 bg-slate-900/40 p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">
              Meta ad creative performance
            </div>
            <div className="mt-1 text-lg font-semibold text-white">
              {currentRangeLabel}
              {loadingCache && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  checking cache...
                </span>
              )}
              {refreshing && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  refreshing from Meta...
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {hasCache
                ? `${formatCount(data?.rowCount)} cached ads from ${data?.eligibleAccountCount}/${data?.accountCount} recent-spend accounts. Last refreshed ${formatDateTime(data?.refreshedAt)}.`
                : "No cached Meta ads for this date range yet. Click Refresh Meta ads to pull and cache it."}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                Date range
              </label>
              <select
                value={dateRangePreset}
                onChange={handleDateRangeChange}
                disabled={loading}
                className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {DATE_RANGE_ORDER.map((p) => (
                  <option key={p} value={p} className="bg-slate-900 text-white">
                    {DATE_RANGE_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            {dateRangePreset === "custom" && (
              <div className="flex items-end gap-2">
                <DateInput
                  label="From"
                  value={customDateFrom}
                  onChange={setCustomDateFrom}
                />
                <DateInput
                  label="To"
                  value={customDateTo}
                  onChange={setCustomDateTo}
                />
                <button
                  type="button"
                  onClick={handleCustomDateApply}
                  disabled={!customDateFrom || !customDateTo || loading}
                  className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {hasCache ? "Refresh Meta ads" : "Load Meta ads"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            {error}
          </div>
        )}

        {data?.warnings?.length ? (
          <details className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-100">
            <summary className="cursor-pointer font-medium">
              {data.warnings.length} Meta warning
              {data.warnings.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-1">
              {data.warnings.slice(0, 8).map((warning, idx) => (
                <li key={`${warning.campaignKey ?? warning.adAccountId ?? idx}`}>
                  {warning.campaignKey ? `${warning.campaignKey}: ` : ""}
                  {warning.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {hasCache && data?.totals && (
        <>
          <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <SummaryCard label="Spend" value={formatMoney(data.totals.spend)} />
            <SummaryCard
              label="Link clicks"
              value={formatCount(data.totals.inlineLinkClicks)}
            />
            <SummaryCard label="Leads" value={formatCount(data.totals.leads)} />
            <SummaryCard label="CPL" value={formatMoneyDecimal(data.totals.cpl)} />
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/30 p-4">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Ads leaderboard
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  {showUntaggedOnly
                    ? `Showing ${formatCount(filteredRows.length)} untagged ads.`
                    : `Showing ${formatCount(filteredRows.length)} top-level rows: ${formatCount(groupedAdCount)} ads grouped into ${activePhrases} phrase and ${activeTagRules} tag rollups; ungrouped ads remain below.`}
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Add rollup phrase
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newPhrase}
                      onChange={(e) => setNewPhrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddPhrase();
                        }
                      }}
                      placeholder="shoulderimage"
                      disabled={savingRollup}
                      className="w-48 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddPhrase()}
                      disabled={!newPhrase.trim() || savingRollup}
                      className="rounded-lg bg-slate-800 px-3 py-2 font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
                    Search
                  </label>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Ad, ad set, campaign, client..."
                    className="w-72 max-w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowUntaggedOnly((v) => !v)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    showUntaggedOnly
                      ? "border-indigo-400/40 bg-indigo-500/20 text-indigo-100"
                      : "border-white/10 bg-slate-800/60 text-slate-200 hover:bg-slate-700"
                  }`}
                  title="Show ads with no saved tags"
                >
                  No tags ({formatCount(untaggedCount)})
                </button>
              </div>
            </div>

            <TagControls
              tags={data.tags}
              selectedCount={selectedCount}
              selectedTagSummary={selectedTagSummary}
              bulkTagId={bulkTagId}
              newTagName={newTagName}
              disabled={savingRollup}
              onBulkTagIdChange={setBulkTagId}
              onNewTagNameChange={setNewTagName}
              onAddTag={() => void handleAddTag()}
              onApplyTag={() => void handleApplyTagToSelected()}
              onClearSelection={() => setSelectedAdIds(new Set())}
            />

            <ThumbnailMatchControls
              groups={thumbnailGroups}
              threshold={thumbnailThreshold}
              loading={matchingThumbnails}
              error={thumbnailMatchError}
              allAdRows={untaggedAdRows}
              selectedAdIds={selectedAdIds}
              activeGroupId={activeThumbnailGroupId}
              disabled={untaggedAdRows.length === 0}
              onThresholdChange={setThumbnailThreshold}
              onFind={() => void handleFindThumbnailGroups()}
              onSelectGroup={selectThumbnailGroup}
              onReviewGroup={(group) => setActiveThumbnailGroupId(group.id)}
              onToggleAd={toggleAdSelection}
              onRemoveTag={handleRemoveTagFromAd}
            />

            <RollupPhraseChips
              phrases={data.phrases}
              disabled={savingRollup}
              onToggle={(phrase) => void handleTogglePhrase(phrase)}
              onDelete={(phrase) => void handleDeletePhrase(phrase)}
            />

            <TagRollupControls
              tags={data.tags}
              rules={data.tagRollupRules ?? []}
              name={newTagRollupName}
              includeMode={tagRollupIncludeMode}
              includeTagIds={tagRollupIncludeIds}
              excludeTagIds={tagRollupExcludeIds}
              disabled={savingRollup}
              onNameChange={setNewTagRollupName}
              onIncludeModeChange={setTagRollupIncludeMode}
              onIncludeTagIdsChange={setTagRollupIncludeIds}
              onExcludeTagIdsChange={setTagRollupExcludeIds}
              onAdd={() => void handleAddTagRollup()}
              onToggle={(rule) => void handleToggleTagRollup(rule)}
              onDelete={(rule) => void handleDeleteTagRollup(rule)}
            />

            <div className="rounded-xl border border-white/10 bg-slate-900/30">
              <div
                ref={tableHeaderScrollRef}
                onScroll={() => syncTableScroll("header")}
                className="sticky top-[4.5rem] z-30 max-w-full overflow-x-hidden rounded-t-xl bg-slate-900 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.9)]"
              >
                <table className="w-[2550px] min-w-full table-fixed border-separate border-spacing-0 text-sm">
                  <MetaAdsTableColGroup />
                  <thead>
                    <TableHeaderRow
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                      allVisibleSelected={allVisibleSelected}
                      someVisibleSelected={someVisibleSelected}
                      visibleAdCount={visibleAdIds.length}
                      onToggleVisible={toggleVisibleAds}
                    />
                  </thead>
                </table>
              </div>
              <div
                ref={tableBodyScrollRef}
                onScroll={() => syncTableScroll("body")}
                className="max-w-full overflow-x-auto"
              >
                <table className="w-[2550px] min-w-full table-fixed border-separate border-spacing-0 divide-y divide-white/5 text-sm">
                  <MetaAdsTableColGroup />
                  <tbody className="divide-y divide-white/5">
                    {filteredRows.map((row) =>
                      row.rowType === "rollup" ? (
                        <RollupGroup
                          key={`${row.rollupKind}-${row.id}`}
                          row={row}
                          isExpanded={expandedRollups.has(
                            `${row.rollupKind}:${row.id}`
                          )}
                          onToggle={() => toggleRollup(`${row.rollupKind}:${row.id}`)}
                          selectedAdIds={selectedAdIds}
                          onToggleAd={toggleAdSelection}
                          onToggleChildren={() =>
                            toggleManyAds(row.children.map((child) => child.adId))
                          }
                          onRemoveTag={handleRemoveTagFromAd}
                        />
                      ) : (
                        <MetaAdTableRow
                          key={row.rowKey}
                          row={row}
                          selected={selectedAdIds.has(row.adId)}
                          onToggleSelected={() => toggleAdSelection(row.adId)}
                          onRemoveTag={handleRemoveTagFromAd}
                        />
                      )
                    )}
                    {filteredRows.length === 0 && (
                      <tr>
                        <td
                          colSpan={14}
                          className="px-4 py-8 text-center text-sm text-slate-400"
                        >
                          No ads match this search.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        {label}
      </label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-white">
        {value}
      </div>
    </div>
  );
}

function RollupPhraseChips({
  phrases,
  disabled,
  onToggle,
  onDelete,
}: {
  phrases: MetaAdsPhrase[];
  disabled: boolean;
  onToggle: (phrase: MetaAdsPhrase) => void;
  onDelete: (phrase: MetaAdsPhrase) => void;
}) {
  if (phrases.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-900/30 p-4 text-sm text-slate-400">
        No rollup phrases yet. Add a phrase like{" "}
        <span className="text-slate-200">shoulderimage</span> or{" "}
        <span className="text-slate-200">xray</span>; enabled phrases appear as
        rollup rows in the table.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-slate-900/30 p-3">
      {phrases.map((phrase) => (
        <span
          key={phrase.id}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
            phrase.enabled
              ? "border-indigo-400/30 bg-indigo-500/15 text-indigo-100"
              : "border-white/10 bg-slate-800/50 text-slate-400"
          }`}
        >
          <span>{phrase.phrase}</span>
          <button
            type="button"
            onClick={() => onToggle(phrase)}
            disabled={disabled}
            className="rounded px-1 text-[10px] uppercase tracking-wide hover:bg-white/10 disabled:opacity-50"
          >
            {phrase.enabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={() => onDelete(phrase)}
            disabled={disabled}
            className="rounded px-1 text-[10px] uppercase tracking-wide text-red-200 hover:bg-red-500/20 disabled:opacity-50"
          >
            Remove
          </button>
        </span>
      ))}
    </div>
  );
}

function TagControls({
  tags,
  selectedCount,
  selectedTagSummary,
  bulkTagId,
  newTagName,
  disabled,
  onBulkTagIdChange,
  onNewTagNameChange,
  onAddTag,
  onApplyTag,
  onClearSelection,
}: {
  tags: MetaAdsTag[];
  selectedCount: number;
  selectedTagSummary: SelectedTagSummary[];
  bulkTagId: string;
  newTagName: string;
  disabled: boolean;
  onBulkTagIdChange: (value: string) => void;
  onNewTagNameChange: (value: string) => void;
  onAddTag: () => void;
  onApplyTag: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="sticky top-0 z-40 flex min-h-[4.5rem] flex-wrap items-end justify-between gap-3 rounded-t-xl border border-white/10 bg-slate-950/95 p-3 text-sm shadow-lg shadow-slate-950/30 backdrop-blur">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Creative tags
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Select ads, apply one or more labels, and keep the selection active while tagging.
        </div>
        {selectedCount > 0 ? (
          <div className="mt-2 flex max-w-xl flex-wrap items-center gap-1.5">
            {selectedTagSummary.length > 0 ? (
              selectedTagSummary.map(({ tag, count }) => (
                <span
                  key={tag.id}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${getTagColorClasses(tag.id)}`}
                  title={`${tag.name} is applied to ${count} of ${selectedCount} selected ads`}
                >
                  <span>{tag.name}</span>
                  <span className="opacity-70">
                    {count}/{selectedCount}
                  </span>
                </span>
              ))
            ) : (
              <span className="rounded-full border border-white/10 bg-slate-800/60 px-2 py-1 text-[10px] text-slate-400">
                No tags on selected ads yet
              </span>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            New tag
          </label>
          <input
            type="text"
            value={newTagName}
            onChange={(e) => onNewTagNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAddTag();
              }
            }}
            placeholder="overlay: border"
            disabled={disabled}
            className="w-44 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <button
          type="button"
          onClick={onAddTag}
          disabled={!newTagName.trim() || disabled}
          className="rounded-lg bg-slate-800 px-3 py-2 font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {selectedCount > 0 ? "Create + apply" : "Create"}
        </button>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Apply to {selectedCount}
          </label>
          <select
            value={bulkTagId}
            onChange={(e) => onBulkTagIdChange(e.target.value)}
            disabled={disabled || tags.length === 0}
            className="max-w-[180px] rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="" className="bg-slate-900">
              Choose tag
            </option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id} className="bg-slate-900">
                {tag.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onApplyTag}
          disabled={!bulkTagId || selectedCount === 0 || disabled}
          className="rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          Apply tag
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          disabled={selectedCount === 0 || disabled}
          className="rounded-lg border border-white/10 bg-slate-800/60 px-3 py-2 text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function ThumbnailMatchControls({
  groups,
  threshold,
  loading,
  error,
  allAdRows,
  selectedAdIds,
  activeGroupId,
  disabled,
  onThresholdChange,
  onFind,
  onSelectGroup,
  onReviewGroup,
  onToggleAd,
  onRemoveTag,
}: {
  groups: ThumbnailMatchGroup[];
  threshold: string;
  loading: boolean;
  error: string | null;
  allAdRows: AdTableRow[];
  selectedAdIds: Set<string>;
  activeGroupId: string | null;
  disabled: boolean;
  onThresholdChange: (value: string) => void;
  onFind: () => void;
  onSelectGroup: (group: ThumbnailMatchGroup) => void;
  onReviewGroup: (group: ThumbnailMatchGroup) => void;
  onToggleAd: (adId: string) => void;
  onRemoveTag: (adId: string, tagId: number) => void;
}) {
  const rowsByAdId = useMemo(
    () => new Map(allAdRows.map((row) => [row.adId, row])),
    [allAdRows]
  );
  const untaggedGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          ads: group.ads.filter((ad) => rowsByAdId.has(ad.adId)),
        }))
        .filter((group) => group.ads.length > 1),
    [groups, rowsByAdId]
  );
  const activeGroup =
    untaggedGroups.find((group) => group.id === activeGroupId) ?? null;
  const activeGroupRows =
    activeGroup?.ads
      .map((ad) => rowsByAdId.get(ad.adId))
      .filter((row): row is AdTableRow => Boolean(row)) ?? [];
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/30 p-3 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Thumbnail matcher
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Find exact and very similar untagged creative thumbnails, select a group,
            then apply tags in bulk above.
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
              Similarity
            </label>
            <select
              value={threshold}
              onChange={(e) => onThresholdChange(e.target.value)}
              disabled={loading}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="4" className="bg-slate-900">
                Strict
              </option>
              <option value="8" className="bg-slate-900">
                Balanced
              </option>
              <option value="12" className="bg-slate-900">
                Loose
              </option>
            </select>
          </div>
          <button
            type="button"
            onClick={onFind}
            disabled={disabled || loading}
            className="rounded-lg bg-slate-800 px-3 py-2 font-medium text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? "Matching..." : "Find matches"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">
          {error}
        </div>
      ) : null}

      {untaggedGroups.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {untaggedGroups.slice(0, 12).map((group) => {
            const selectedCount = group.ads.filter((ad) =>
              selectedAdIds.has(ad.adId)
            ).length;
            return (
              <div
                key={group.id}
                className="flex gap-3 rounded-xl border border-white/10 bg-slate-950/40 p-3"
              >
                <div
                  className="h-16 w-16 shrink-0 rounded-lg border border-white/10 bg-cover bg-center"
                  style={{
                    backgroundImage: `url("${group.representativeThumbnailUrl}")`,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        group.matchType === "exact"
                          ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-100"
                          : "border-sky-400/30 bg-sky-500/15 text-sky-100"
                      }`}
                    >
                      {group.matchType}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatCount(group.ads.length)} ads
                      {group.matchType === "similar"
                        ? `, max distance ${group.maxDistance}`
                        : ""}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {group.ads.slice(0, 3).map((ad) => (
                      <div key={ad.adId} className="truncate text-xs text-slate-300">
                        {ad.adName}
                        {typeof ad.spend === "number" ? (
                          <span className="text-slate-500">
                            {" "}
                            ({formatMoney(ad.spend)})
                          </span>
                        ) : null}
                      </div>
                    ))}
                    {group.ads.length > 3 ? (
                      <div className="text-xs text-slate-500">
                        +{formatCount(group.ads.length - 3)} more
                      </div>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectGroup(group)}
                  className="self-start rounded-lg border border-white/10 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700"
                >
                  {selectedCount === group.ads.length ? "Unselect" : "Select"}
                </button>
                <button
                  type="button"
                  onClick={() => onReviewGroup(group)}
                  className={`self-start rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    activeGroupId === group.id
                      ? "border-indigo-400/40 bg-indigo-500/20 text-indigo-100"
                      : "border-white/10 bg-slate-800/70 text-slate-100 hover:bg-slate-700"
                  }`}
                >
                  Review
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          Run matching to surface duplicate or near-duplicate untagged thumbnail groups.
        </div>
      )}

      {activeGroup ? (
        <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-100">
                Reviewing {activeGroup.matchType} match group
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {formatCount(activeGroupRows.length)} ads. Use the row checkboxes to
                remove or re-add ads before applying tags; tag pills can be removed live.
              </div>
            </div>
            <div className="text-xs text-slate-500">
              {formatCount(
                activeGroupRows.filter((row) => selectedAdIds.has(row.adId)).length
              )}{" "}
              selected
            </div>
          </div>
          <div className="mt-3 max-h-[34rem] overflow-auto rounded-xl border border-white/10 bg-slate-950/40">
            <table className="w-[2550px] min-w-full table-fixed border-separate border-spacing-0 divide-y divide-white/5 text-sm">
              <MetaAdsTableColGroup />
              <thead>
                <ThumbnailReviewHeader />
              </thead>
              <tbody className="divide-y divide-white/5">
                {activeGroupRows.map((row) => (
                  <MetaAdTableRow
                    key={`thumbnail-review-${row.rowKey}`}
                    row={row}
                    selected={selectedAdIds.has(row.adId)}
                    onToggleSelected={() => onToggleAd(row.adId)}
                    onRemoveTag={onRemoveTag}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TagRollupControls({
  tags,
  rules,
  name,
  includeMode,
  includeTagIds,
  excludeTagIds,
  disabled,
  onNameChange,
  onIncludeModeChange,
  onIncludeTagIdsChange,
  onExcludeTagIdsChange,
  onAdd,
  onToggle,
  onDelete,
}: {
  tags: MetaAdsTag[];
  rules: MetaAdsTagRollupRule[];
  name: string;
  includeMode: "all" | "any";
  includeTagIds: string[];
  excludeTagIds: string[];
  disabled: boolean;
  onNameChange: (value: string) => void;
  onIncludeModeChange: (value: "all" | "any") => void;
  onIncludeTagIdsChange: (value: string[]) => void;
  onExcludeTagIdsChange: (value: string[]) => void;
  onAdd: () => void;
  onToggle: (rule: MetaAdsTagRollupRule) => void;
  onDelete: (rule: MetaAdsTagRollupRule) => void;
}) {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag.name]));
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/30 p-3 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Tag rollups
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Build saved rollup rows from tag combinations, like shoulder + female or
            shoulder/knee excluding female.
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
              Rollup name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Shoulder - female"
              disabled={disabled}
              className="w-44 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
              Match
            </label>
            <select
              value={includeMode}
              onChange={(e) => onIncludeModeChange(e.target.value === "any" ? "any" : "all")}
              disabled={disabled}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="all" className="bg-slate-900">
                all included tags
              </option>
              <option value="any" className="bg-slate-900">
                any included tag
              </option>
            </select>
          </div>
          <TagMultiSelect
            label="Include"
            tags={tags}
            value={includeTagIds}
            disabled={disabled}
            onChange={onIncludeTagIdsChange}
          />
          <TagMultiSelect
            label="Exclude"
            tags={tags}
            value={excludeTagIds}
            disabled={disabled}
            onChange={onExcludeTagIdsChange}
          />
          <button
            type="button"
            onClick={onAdd}
            disabled={!name.trim() || includeTagIds.length === 0 || disabled}
            className="rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            Add rollup
          </button>
        </div>
      </div>

      {rules.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {rules.map((rule) => (
            <span
              key={rule.id}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                rule.enabled
                  ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-100"
                  : "border-white/10 bg-slate-800/50 text-slate-400"
              }`}
              title={describeTagRollupRule(rule, tagsById)}
            >
              <span>{rule.name}</span>
              <span className="text-[10px] text-slate-400">
                {rule.includeMode.toUpperCase()}
              </span>
              <button
                type="button"
                onClick={() => onToggle(rule)}
                disabled={disabled}
                className="rounded px-1 text-[10px] uppercase tracking-wide hover:bg-white/10 disabled:opacity-50"
              >
                {rule.enabled ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={() => onDelete(rule)}
                disabled={disabled}
                className="rounded px-1 text-[10px] uppercase tracking-wide text-red-200 hover:bg-red-500/20 disabled:opacity-50"
              >
                Remove
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          No tag rollups yet. Use Include + Match for AND/OR, and Exclude for NOT.
        </div>
      )}
    </div>
  );
}

function TagMultiSelect({
  label,
  tags,
  value,
  disabled,
  onChange,
}: {
  label: string;
  tags: MetaAdsTag[];
  value: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
        {label}
      </label>
      <select
        multiple
        value={value}
        onChange={(e) =>
          onChange(Array.from(e.currentTarget.selectedOptions).map((option) => option.value))
        }
        disabled={disabled || tags.length === 0}
        className="h-[4.75rem] min-w-[160px] rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id} className="bg-slate-900">
            {tag.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function describeTagRollupRule(
  rule: MetaAdsTagRollupRule,
  tagsById: Map<number, string>
): string {
  const include = rule.includeTagIds
    .map((tagId) => tagsById.get(tagId) ?? `Tag ${tagId}`)
    .join(rule.includeMode === "all" ? " AND " : " OR ");
  const exclude = rule.excludeTagIds
    .map((tagId) => tagsById.get(tagId) ?? `Tag ${tagId}`)
    .join(", ");
  return exclude ? `${include}; exclude ${exclude}` : include;
}

function MetaAdsTableColGroup() {
  return (
    <colgroup>
      <col className="w-[420px]" />
      <col className="w-[180px]" />
      <col className="w-[290px]" />
      <col className="w-[380px]" />
      <col className="w-[290px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
      <col className="w-[110px]" />
    </colgroup>
  );
}

function ThumbnailReviewHeader() {
  return (
    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
      <th className="sticky left-0 z-30 border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]">
        Ad
      </th>
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Tags
      </th>
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Client
      </th>
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Campaign
      </th>
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Ad set
      </th>
      {[
        "Spend",
        "Impr.",
        "Reach",
        "Link clicks",
        "CTR",
        "CPC",
        "CPM",
        "Leads",
        "CPL",
      ].map((label) => (
        <th
          key={label}
          className="border-b border-white/10 bg-slate-900 px-3 py-3 text-right font-semibold"
        >
          {label}
        </th>
      ))}
    </tr>
  );
}

function TableHeaderRow({
  sortKey,
  sortDir,
  onSort,
  allVisibleSelected,
  someVisibleSelected,
  visibleAdCount,
  onToggleVisible,
}: {
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  visibleAdCount: number;
  onToggleVisible: () => void;
}) {
  return (
    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
      <th className="sticky left-0 z-30 border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]">
        <span className="inline-flex items-center gap-2">
          <IndeterminateCheckbox
            checked={allVisibleSelected}
            indeterminate={someVisibleSelected}
            disabled={visibleAdCount === 0}
            onChange={onToggleVisible}
            ariaLabel="Select all visible ads"
          />
          <button
            type="button"
            onClick={() => onSort("adName")}
            className="inline-flex items-center gap-1 hover:text-white"
          >
            Ad
            {sortKey === "adName" && (
              <span className="text-[10px]">{sortDir === "desc" ? "v" : "^"}</span>
            )}
          </button>
        </span>
      </th>
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Tags
      </th>
      <SortableTh
        label="Client"
        active={sortKey === "businessName"}
        dir={sortDir}
        onClick={() => onSort("businessName")}
      />
      <SortableTh
        label="Campaign"
        active={sortKey === "campaignName"}
        dir={sortDir}
        onClick={() => onSort("campaignName")}
      />
      <th className="border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold">
        Ad set
      </th>
      {(
        [
          "spend",
          "impressions",
          "reach",
          "inlineLinkClicks",
          "ctr",
          "cpc",
          "cpm",
          "leads",
          "cpl",
        ] as SortKey[]
      ).map((key) => (
        <SortableTh
          key={key}
          label={SORT_LABELS[key]}
          active={sortKey === key}
          dir={sortDir}
          onClick={() => onSort(key)}
          alignRight
        />
      ))}
    </tr>
  );
}

function IndeterminateCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 rounded border-white/20 bg-slate-900 text-indigo-500 disabled:opacity-40"
      aria-label={ariaLabel}
    />
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  alignRight,
  sticky,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  alignRight?: boolean;
  sticky?: boolean;
}) {
  return (
    <th
      className={`${sticky ? "sticky left-0 z-30 shadow-[4px_0_12px_-4px_rgba(0,0,0,0.45)]" : ""} cursor-pointer border-b border-white/10 bg-slate-900 px-3 py-3 font-semibold hover:text-white ${
        alignRight ? "text-right" : "text-left"
      }`}
      onClick={onClick}
    >
      <span
        className={`inline-flex items-center gap-1 ${
          alignRight ? "justify-end" : ""
        }`}
      >
        {label}
        {active && <span className="text-[10px]">{dir === "desc" ? "v" : "^"}</span>}
      </span>
    </th>
  );
}

function RollupGroup({
  row,
  isExpanded,
  onToggle,
  selectedAdIds,
  onToggleAd,
  onToggleChildren,
  onRemoveTag,
}: {
  row: Extract<AdsTableRow, { rowType: "rollup" }>;
  isExpanded: boolean;
  onToggle: () => void;
  selectedAdIds: Set<string>;
  onToggleAd: (adId: string) => void;
  onToggleChildren: () => void;
  onRemoveTag: (adId: string, tagId: number) => void;
}) {
  return (
    <>
      <RollupTableRow
        row={row}
        isExpanded={isExpanded}
        onToggle={onToggle}
        onToggleChildren={onToggleChildren}
      />
      {isExpanded &&
        row.children.map((child) => (
          <MetaAdTableRow
            key={`${row.id}-${child.rowKey}`}
            row={child}
            nested
            selected={selectedAdIds.has(child.adId)}
            onToggleSelected={() => onToggleAd(child.adId)}
            onRemoveTag={onRemoveTag}
          />
        ))}
    </>
  );
}

function RollupTableRow({
  row,
  isExpanded,
  onToggle,
  onToggleChildren,
}: {
  row: Extract<AdsTableRow, { rowType: "rollup" }>;
  isExpanded: boolean;
  onToggle: () => void;
  onToggleChildren: () => void;
}) {
  const label = row.rollupKind === "tag" ? row.name : row.phrase;
  const badge = row.rollupKind === "tag" ? "Tag rule" : "Phrase";
  const detail =
    row.rollupKind === "tag"
      ? `${row.includeMode === "all" ? "All" : "Any"} included tags${
          row.excludeTagIds.length ? `; ${row.excludeTagIds.length} excluded` : ""
        }`
      : `Contains "${row.phrase}"`;
  return (
    <tr className="bg-indigo-500/10 hover:bg-indigo-500/15">
      <td className="sticky left-0 z-10 min-w-[340px] bg-slate-950/95 px-3 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-indigo-200 transition-colors hover:bg-indigo-500/20 hover:text-white"
            aria-label={isExpanded ? "Collapse rollup" : "Expand rollup"}
          >
            <span
              className={`text-[10px] transition-transform ${
                isExpanded ? "rotate-90" : ""
              }`}
            >
              &gt;
            </span>
          </button>
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-indigo-400/30 bg-indigo-500/15 text-[10px] font-semibold uppercase tracking-wide text-indigo-100">
            Rollup
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-semibold text-indigo-100">
                {label}
              </div>
              <span className="rounded bg-indigo-500/20 px-1.5 py-px text-[10px] uppercase tracking-wide text-indigo-100">
                {badge}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {formatCount(row.children.length)} matching ads
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-slate-300">
        <span className="inline-flex rounded-full border border-indigo-400/30 bg-indigo-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-100">
          {badge}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-slate-200">
        <div className="font-medium">Rollup</div>
        <div className="text-[11px] text-slate-500">
          {row.rollupKind === "tag" ? "Tag combo" : "Phrase match"}
        </div>
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        {detail}
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        <button
          type="button"
          onClick={onToggleChildren}
          className="rounded-md border border-white/10 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-700"
        >
          Select children
        </button>
      </td>
      <MetricTd value={formatMoney(row.spend)} />
      <MetricTd value={formatCount(row.impressions)} />
      <MetricTd value={formatCount(row.reach)} />
      <MetricTd value={formatCount(row.inlineLinkClicks)} />
      <MetricTd value={formatPercent(row.ctr)} />
      <MetricTd value={formatMoneyDecimal(row.cpc)} />
      <MetricTd value={formatMoneyDecimal(row.cpm)} />
      <MetricTd value={formatCount(row.leads)} />
      <MetricTd value={formatMoneyDecimal(row.cpl)} />
    </tr>
  );
}

function MetaAdTableRow({
  row,
  nested,
  selected,
  onToggleSelected,
  onRemoveTag,
}: {
  row: AdTableRow;
  nested?: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onRemoveTag: (adId: string, tagId: number) => void;
}) {
  return (
    <tr className={nested ? "bg-slate-950/35 hover:bg-white/5" : "hover:bg-white/5"}>
      <td
        className={`sticky left-0 z-10 min-w-[340px] bg-slate-950/80 px-3 py-3 ${
          nested ? "pl-14" : ""
        }`}
      >
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="h-4 w-4 rounded border-white/20 bg-slate-900 text-indigo-500"
            aria-label={`Select ${row.adName}`}
          />
          <CreativeThumb url={row.thumbnailUrl} adName={row.adName} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-medium text-slate-100">{row.adName}</div>
              {row.adsManagerUrl && (
                <a
                  href={row.adsManagerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded border border-white/10 bg-slate-800/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300 transition-colors hover:border-indigo-400/50 hover:text-indigo-200"
                  title="Open ad in Meta Ads Manager"
                >
                  Open
                </a>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
              <span>{row.adId}</span>
              {row.matchingRollups.map((rollup) => (
                <span
                  key={rollup.id}
                  className="rounded bg-indigo-500/15 px-1.5 py-px text-indigo-200"
                  title={`Included in ${rollup.phrase} rollup`}
                >
                  in {rollup.phrase}
                </span>
              ))}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-slate-300">
        <TagPills tags={row.tags} adId={row.adId} onRemoveTag={onRemoveTag} />
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-slate-200">
        <div className="font-medium">{row.businessName}</div>
        <div className="text-[11px] text-slate-500">
          {row.status}
          {row.cid ? ` - CID ${row.cid}` : ""}
        </div>
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        <div className="line-clamp-2">{row.campaignName ?? "Campaign"}</div>
        {row.campaignKeyword && (
          <div className="mt-1 text-[11px] text-slate-500">
            Filter: {row.campaignKeyword}
          </div>
        )}
      </td>
      <td className="min-w-[220px] px-3 py-3 text-slate-300">
        <div className="line-clamp-2">{row.adsetName ?? "Ad set"}</div>
      </td>
      <MetricTd value={formatMoney(row.spend)} />
      <MetricTd value={formatCount(row.impressions)} />
      <MetricTd value={formatCount(row.reach)} />
      <MetricTd value={formatCount(row.inlineLinkClicks)} />
      <MetricTd value={formatPercent(row.ctr)} />
      <MetricTd value={formatMoneyDecimal(row.cpc)} />
      <MetricTd value={formatMoneyDecimal(row.cpm)} />
      <MetricTd value={formatCount(row.leads)} />
      <MetricTd value={formatMoneyDecimal(row.cpl)} />
    </tr>
  );
}

function TagPills({
  tags,
  adId,
  onRemoveTag,
}: {
  tags: MetaAdsTag[];
  adId: string;
  onRemoveTag: (adId: string, tagId: number) => void;
}) {
  if (tags.length === 0) {
    return <span className="text-xs text-slate-600">No tags</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${getTagColorClasses(tag.id)}`}
          title={`Tagged ${tag.name}`}
        >
          <span className="truncate">{tag.name}</span>
          <button
            type="button"
            onClick={() => onRemoveTag(adId, tag.id)}
            className="rounded-full px-0.5 text-[10px] leading-none hover:bg-white/15"
            aria-label={`Remove ${tag.name} tag`}
          >
            x
          </button>
        </span>
      ))}
    </div>
  );
}

function getTagColorClasses(tagId: number): string {
  return TAG_COLOR_CLASSES[Math.abs(tagId) % TAG_COLOR_CLASSES.length];
}

function CreativeThumb({ url, adName }: { url: string | null; adName: string }) {
  if (!url) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-slate-800 text-[10px] uppercase tracking-wide text-slate-500">
        No img
      </div>
    );
  }
  return (
    <div
      aria-label={`Thumbnail for ${adName}`}
      className="h-14 w-14 shrink-0 rounded-lg border border-white/10 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: `url("${url}")` }}
    />
  );
}

function MetricTd({ value }: { value: string }) {
  return (
    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-200">
      {value}
    </td>
  );
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function adMatchesQuery(row: MetaAdsRow, query: string): boolean {
  return [
    row.businessName,
    row.ownerName,
    row.adName,
    row.adsetName,
    row.campaignName,
    row.cid,
    row.campaignKeyword,
  ]
    .filter(Boolean)
    .some((value) => normalizeSearch(String(value)).includes(query));
}

function compareRows(
  a: AdsTableRow,
  b: AdsTableRow,
  key: SortKey,
  dir: "asc" | "desc"
): number {
  const av = getSortValue(a, key);
  const bv = getSortValue(b, key);
  let result = 0;
  if (typeof av === "string" || typeof bv === "string") {
    result = String(av ?? "").localeCompare(String(bv ?? ""));
  } else {
    const an = av ?? Number.NEGATIVE_INFINITY;
    const bn = bv ?? Number.NEGATIVE_INFINITY;
    result = an === bn ? 0 : an > bn ? 1 : -1;
  }
  return dir === "desc" ? result * -1 : result;
}

function getSortValue(row: AdsTableRow, key: SortKey): string | number | null {
  switch (key) {
    case "adName":
      return row.rowType === "rollup"
        ? row.rollupKind === "tag"
          ? row.name
          : row.phrase
        : row.adName;
    case "businessName":
      return row.rowType === "rollup" ? "Rollup" : row.businessName;
    case "campaignName":
      return row.rowType === "rollup"
        ? row.rollupKind === "tag"
          ? row.name
          : row.phrase
        : row.campaignName;
    default:
      return row[key];
  }
}
