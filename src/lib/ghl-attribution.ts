/**
 * Per-opportunity attribution breakdown: join opportunities to contact attribution.
 * Reads contact.attributionSource (and related nested objects) + customFields for gaps.
 * Campaign = utmCampaign or `campaign`; ad set = utmMedium; ad = utmContent.
 * Does not use opportunity Source or opportunity-level UTMs.
 */

import {
  type GHLPipeline,
  type GHLOpportunity,
  type AttributionMode,
  STATUS_WON_KEY,
  getOpportunityAttributionLocalDate,
  isOpportunityWon,
  ghlAuthHeaders,
  ghlDelay,
} from "@/lib/ghl-oauth";
import {
  calculateFunnelMetrics,
  classifyOpportunityFunnelBucket,
  type CustomStageMappings,
} from "@/lib/funnel-metrics";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_MAX_PAGES = 40;
const GHL_DELAY_MS = 150;
const GHL_429_RETRY_MS = 3000;
const CONTACT_FETCH_DELAY_MS = 120;

export type AttributionDimension = "content" | "medium" | "campaign" | "source";

export interface ContactAttributionFields {
  utmSource: string;
  utmMedium: string;
  utmContent: string;
  utmCampaign: string;
}

/** Meta IDs from GHL contact attribution (for spend join). */
export interface ContactMetaIds {
  campaignId: string;
  adSetId: string;
  adId: string;
}

export interface AttributionContactDetail {
  contactId: string | null;
  name: string;
  bucket: string;
  stageName: string;
  value: number;
  attribution: ContactAttributionFields;
  metaIds: ContactMetaIds;
}

export interface AttributionBreakdownRow {
  key: string;
  leads: number;
  requested: number;
  confirmed: number;
  showed: number;
  noShow: number;
  unmapped: number;
  /** Same definition as Month to Month “Closed”: won + success-mapped stages (see classifyOpportunityFunnelBucket). */
  closed: number;
  total: number;
  totalValue: number;
  /** Monetary value for closed opps in this row (matches funnel successValue / monthly Total Value Closed). */
  closedValue: number;
  bookingRate: number | null;
  showRate: number | null;
  /** Closed ÷ Showed % when showed > 0 (same formula as funnel showedConversionRate numerator). */
  closedPerShowed: number | null;
  /** Facebook spend for this row’s Meta IDs in the report date range (server-filled). */
  spend: number | null;
  /** How spend was joined to Meta insights, useful when debugging missing ad IDs. */
  spendMatch: "id" | "name" | null;
  /** Contacts/opportunities that make up this row, used by dashboard drill-downs. */
  contacts: AttributionContactDetail[];
}

/** Internal until spend is merged; stripped before API response. */
export type AttributionBreakdownRowInternal = AttributionBreakdownRow & {
  spendJoinIds: string[];
};

function buildStageIdToName(
  stages: Array<{ id: string; name: string }> | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!stages) return map;
  for (const s of stages) {
    map.set(s.id, s.name);
  }
  return map;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function pickMetaId(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return s;
  }
  return "";
}

const EMPTY_META_IDS: ContactMetaIds = {
  campaignId: "",
  adSetId: "",
  adId: "",
};

/**
 * Read Meta campaign / ad set / ad IDs from attributionSource and related objects (first wins).
 */
export function extractMetaIdsFromContactJson(
  raw: Record<string, unknown>
): ContactMetaIds {
  const contact = (raw.contact ?? raw) as Record<string, unknown>;
  let campaignId = "";
  let adSetId = "";
  let adId = "";

  const absorb = (o: Record<string, unknown>) => {
    const c = pickMetaId(o, ["campaignId", "campaign_id"]);
    const a = pickMetaId(o, ["adSetId", "adset_id", "adsetid"]);
    const d = pickMetaId(o, ["adId", "ad_id"]);
    const term = pickMetaId(o, ["utmTerm", "utm_term"]);
    if (c && !campaignId) campaignId = c;
    if (a && !adSetId) adSetId = a;
    else if (term && !adSetId) adSetId = term;
    if (d && !adId) adId = d;
  };

  const nestedKeys = [
    "attributionSource",
    "attribution",
    "lastAttribution",
    "last_attribution",
    "sessionAttribution",
    "attributions",
    "lastAttributionSource",
  ] as const;

  for (const nk of nestedKeys) {
    const node = contact[nk];
    if (node == null) continue;
    const nodes = Array.isArray(node) ? node : [node];
    for (const n of nodes) {
      if (n && typeof n === "object") absorb(n as Record<string, unknown>);
    }
  }

  return { campaignId, adSetId, adId };
}

function stringifyCustomFieldValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
    return parts.join(", ");
  }
  return "";
}

/** Collapse NBSP / runs of whitespace for stable grouping keys. */
export function normalizeAttributionLabel(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map custom field key → standard UTM slot (order matters: campaign before medium, etc.). */
function classifyCustomFieldUtmKey(
  keyLower: string
): keyof ContactAttributionFields | null {
  if (
    keyLower.includes("utm_campaign") ||
    (keyLower.includes("utm") && keyLower.includes("campaign"))
  ) {
    return "utmCampaign";
  }
  if (
    keyLower.includes("utm_medium") ||
    (keyLower.includes("utm") && keyLower.includes("medium"))
  ) {
    return "utmMedium";
  }
  if (
    keyLower.includes("utm_content") ||
    (keyLower.includes("utm") && keyLower.includes("content"))
  ) {
    return "utmContent";
  }
  if (
    keyLower.includes("utm_source") ||
    (keyLower.includes("utm") && keyLower.includes("source"))
  ) {
    return "utmSource";
  }
  return null;
}

/** GHL often stores UTMs in `customFields` as `{ id, value, fieldKey? }`. */
function extractUtmFromCustomFields(
  contact: Record<string, unknown>
): Partial<ContactAttributionFields> {
  const raw = contact.customFields;
  if (!Array.isArray(raw)) return {};
  const out: Partial<ContactAttributionFields> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const keyRaw = [
      o.fieldKey,
      o.key,
      o.name,
      o.field_key,
    ]
      .filter((x) => x != null)
      .join(" ")
      .toLowerCase();
    const val = stringifyCustomFieldValue(o.value);
    if (!val) continue;
    const slot = classifyCustomFieldUtmKey(keyRaw);
    if (slot && !out[slot]) out[slot] = val;
  }
  return out;
}

/**
 * GHL stores Meta / form UTMs on contacts under `attributionSource` (lead capture).
 * `lastAttributionSource` is a fallback (e.g. landing URL); it comes after so first-touch wins.
 * `campaign` on those objects maps to our utmCampaign slot (same as utmCampaign).
 */
function extractUtmFromNestedObjects(contact: Record<string, unknown>): Partial<ContactAttributionFields> {
  const nestedKeys = [
    "attributionSource",
    "attribution",
    "lastAttribution",
    "last_attribution",
    "sessionAttribution",
    "attributions",
    "lastAttributionSource",
  ];
  const merged: Partial<ContactAttributionFields> = {};
  for (const nk of nestedKeys) {
    const node = contact[nk];
    if (node == null) continue;
    const nodes = Array.isArray(node) ? node : [node];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const o = n as Record<string, unknown>;
      const layer = {
        utmSource: pickStr(o, [
          "utmSource",
          "utm_source",
          "UtmSource",
          "source",
        ]),
        utmMedium: pickStr(o, ["utmMedium", "utm_medium", "UtmMedium"]),
        utmContent: pickStr(o, ["utmContent", "utm_content", "UtmContent"]),
        utmCampaign: pickStr(o, [
          "utmCampaign",
          "utm_campaign",
          "UtmCampaign",
          "campaign",
        ]),
      };
      if (layer.utmSource && !merged.utmSource) merged.utmSource = layer.utmSource;
      if (layer.utmMedium && !merged.utmMedium) merged.utmMedium = layer.utmMedium;
      if (layer.utmContent && !merged.utmContent) merged.utmContent = layer.utmContent;
      if (layer.utmCampaign && !merged.utmCampaign) merged.utmCampaign = layer.utmCampaign;
    }
  }
  return merged;
}

function mergeAttributionFirstWins(
  ...layers: Partial<ContactAttributionFields>[]
): ContactAttributionFields {
  const keys = [
    "utmSource",
    "utmMedium",
    "utmContent",
    "utmCampaign",
  ] as const;
  const out: ContactAttributionFields = {
    utmSource: "",
    utmMedium: "",
    utmContent: "",
    utmCampaign: "",
  };
  for (const k of keys) {
    for (const layer of layers) {
      const v = layer[k];
      if (typeof v === "string" && v.trim()) {
        out[k] = v.trim();
        break;
      }
    }
  }
  return out;
}

/**
 * Parse GHL contact JSON (wrapped `{ contact }` or flat).
 * Priority: top-level utm_* → attributionSource / nested attribution → customFields (gaps only).
 */
export function extractContactAttributionFromContactJson(
  raw: Record<string, unknown>
): ContactAttributionFields {
  const contact = (raw.contact ?? raw) as Record<string, unknown>;
  const fromTop: Partial<ContactAttributionFields> = {
    utmSource: pickStr(contact, ["utmSource", "utm_source", "UtmSource"]),
    utmMedium: pickStr(contact, ["utmMedium", "utm_medium", "UtmMedium"]),
    utmContent: pickStr(contact, ["utmContent", "utm_content", "UtmContent"]),
    utmCampaign: pickStr(contact, [
      "utmCampaign",
      "utm_campaign",
      "UtmCampaign",
      "campaign",
    ]),
  };
  const fromNested = extractUtmFromNestedObjects(contact);
  const fromCf = extractUtmFromCustomFields(contact);
  return mergeAttributionFirstWins(fromTop, fromNested, fromCf);
}

function resolveAttributionKey(
  dimension: AttributionDimension,
  fields: ContactAttributionFields
): string {
  const unknown = "(unknown)";
  let raw: string;
  switch (dimension) {
    case "source":
      raw = fields.utmSource;
      break;
    case "campaign":
      raw = fields.utmCampaign;
      break;
    case "medium":
      raw = fields.utmMedium;
      break;
    case "content":
      raw = fields.utmContent;
      break;
    default:
      raw = "";
  }
  if (!raw?.trim()) return unknown;
  const norm = normalizeAttributionLabel(raw);
  return norm || unknown;
}

function getOppMonetaryValue(opp: GHLOpportunity): number {
  if (typeof opp.monetaryValue === "number") return opp.monetaryValue;
  const mv = (opp as Record<string, unknown>).monetary_value;
  return typeof mv === "number" ? mv : 0;
}

type RowAgg = {
  leads: number;
  requested: number;
  confirmed: number;
  showed: number;
  noShow: number;
  unmapped: number;
  closed: number;
  total: number;
  totalValue: number;
  closedValue: number;
  adIds: Set<string>;
  adSetIds: Set<string>;
  campaignIds: Set<string>;
  contacts: AttributionContactDetail[];
};

function emptyRowAgg(): RowAgg {
  return {
    leads: 0,
    requested: 0,
    confirmed: 0,
    showed: 0,
    noShow: 0,
    unmapped: 0,
    closed: 0,
    total: 0,
    totalValue: 0,
    closedValue: 0,
    adIds: new Set(),
    adSetIds: new Set(),
    campaignIds: new Set(),
    contacts: [],
  };
}

function addMetaIdsToRow(row: RowAgg, m: ContactMetaIds) {
  if (m.adId) row.adIds.add(m.adId);
  if (m.adSetId) row.adSetIds.add(m.adSetId);
  if (m.campaignId) row.campaignIds.add(m.campaignId);
}

function addToRow(row: RowAgg, bucket: string, value: number) {
  row.total += 1;
  row.totalValue += value;
  switch (bucket) {
    case "lead":
      row.leads += 1;
      break;
    case "requested":
      row.requested += 1;
      break;
    case "confirmed":
      row.confirmed += 1;
      break;
    case "showed":
      row.showed += 1;
      break;
    case "noShow":
      row.noShow += 1;
      break;
    case "closed":
      row.closed += 1;
      row.closedValue += value;
      break;
    case "unmapped":
      row.unmapped += 1;
      break;
    default:
      row.unmapped += 1;
  }
}

function finalizeRow(
  key: string,
  row: RowAgg,
  dimension: AttributionDimension
): AttributionBreakdownRowInternal {
  const totalAppts = row.requested + row.confirmed;
  const pool = row.leads + totalAppts;
  const bookingRate =
    pool > 0 ? Math.round((totalAppts / pool) * 1000) / 10 : null;
  const showRate =
    totalAppts > 0 ? Math.round((row.showed / totalAppts) * 1000) / 10 : null;
  const closedPerShowed =
    row.showed > 0
      ? Math.round((row.closed / row.showed) * 1000) / 10
      : null;

  const spendJoinIds =
    dimension === "content"
      ? [...row.adIds]
      : dimension === "medium"
        ? [...row.adSetIds]
        : dimension === "campaign"
          ? [...row.campaignIds]
          : [];

  return {
    key,
    leads: row.leads,
    requested: row.requested,
    confirmed: row.confirmed,
    showed: row.showed,
    noShow: row.noShow,
    unmapped: row.unmapped,
    closed: row.closed,
    total: row.total,
    totalValue: Math.round(row.totalValue * 100) / 100,
    closedValue: Math.round(row.closedValue * 100) / 100,
    bookingRate,
    showRate,
    closedPerShowed,
    spend: null,
    spendMatch: null,
    contacts: row.contacts,
    spendJoinIds,
  };
}

async function fetchContactAttribution(
  accessToken: string,
  contactId: string,
  locationId: string
): Promise<{
  fields: ContactAttributionFields;
  metaIds: ContactMetaIds;
}> {
  const url = new URL(`${GHL_BASE}/contacts/${contactId}`);
  if (locationId) {
    url.searchParams.set("location_id", locationId);
  }
  const res = await fetch(url.toString(), {
    headers: ghlAuthHeaders(accessToken),
  });
  if (!res.ok) {
    return {
      fields: {
        utmSource: "",
        utmMedium: "",
        utmContent: "",
        utmCampaign: "",
      },
      metaIds: { ...EMPTY_META_IDS },
    };
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    fields: extractContactAttributionFromContactJson(data),
    metaIds: extractMetaIdsFromContactJson(data),
  };
}

async function fetchContactsSequential(
  accessToken: string,
  ids: string[],
  locationId: string
): Promise<
  Map<
    string,
    { fields: ContactAttributionFields; metaIds: ContactMetaIds }
  >
> {
  const map = new Map<
    string,
    { fields: ContactAttributionFields; metaIds: ContactMetaIds }
  >();
  for (let i = 0; i < ids.length; i++) {
    if (i > 0) await ghlDelay(CONTACT_FETCH_DELAY_MS);
    const id = ids[i]!;
    try {
      map.set(id, await fetchContactAttribution(accessToken, id, locationId));
    } catch {
      map.set(id, {
        fields: {
          utmSource: "",
          utmMedium: "",
          utmContent: "",
          utmCampaign: "",
        },
        metaIds: { ...EMPTY_META_IDS },
      });
    }
  }
  return map;
}

export async function getAttributionBreakdown(params: {
  locationId: string;
  pipeline: GHLPipeline;
  accessToken: string;
  dateRange: { startDate: string; endDate: string };
  attributionMode: AttributionMode;
  dimension: AttributionDimension;
  customMappings?: CustomStageMappings;
}): Promise<{
  rows: AttributionBreakdownRowInternal[];
  meta: {
    opportunitiesInRange: number;
    /** Count of opps classified as closed (matches sum of row.closed across rows). */
    closedInRange: number;
    /** Same closed count as Month to Month funnel math on in-range opps (stage histogram + calculateFunnelMetrics). */
    funnelClosedAggregate: number;
    /** False if per-opp buckets disagree with aggregate funnel (should not happen). */
    closedMatchesFunnelAggregate: boolean;
    contactsFetched: number;
    dimension: AttributionDimension;
  };
}> {
  const {
    locationId,
    pipeline,
    accessToken,
    dateRange,
    attributionMode,
    dimension,
    customMappings,
  } = params;

  const stageIdToName = buildStageIdToName(pipeline.stages);
  const pipelineStages = pipeline.stages ?? undefined;
  const limit = 100;
  let page = 1;
  const seenOpp = new Set<string>();
  const inRange: Array<{
    contactId: string | null;
    name: string;
    value: number;
    bucket: string;
    stageName: string;
  }> = [];
  const aggregateCounts: Record<string, number> = {};
  const aggregateValues: Record<string, number> = {};

  while (page <= GHL_MAX_PAGES) {
    if (page > 1) await ghlDelay(GHL_DELAY_MS);

    const searchUrl = new URL(`${GHL_BASE}/opportunities/search`);
    searchUrl.searchParams.set("location_id", locationId);
    searchUrl.searchParams.set("pipeline_id", pipeline.id);
    searchUrl.searchParams.set("status", "all");
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("page", String(page));

    const searchRes = await fetch(searchUrl.toString(), {
      method: "GET",
      headers: ghlAuthHeaders(accessToken),
    });

    if (searchRes.status === 429) {
      await ghlDelay(GHL_429_RETRY_MS);
      continue;
    }

    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`GHL getOpportunities failed: ${searchRes.status} ${err}`);
    }

    const data = await searchRes.json();
    const opportunities: GHLOpportunity[] = data.opportunities ?? data.data ?? [];
    const total = data.total ?? data.totalCount ?? 0;

    for (const opp of opportunities) {
      if (seenOpp.has(opp.id)) continue;
      seenOpp.add(opp.id);

      const dateStr = getOpportunityAttributionLocalDate(
        opp,
        attributionMode
      );
      if (
        dateStr &&
        (dateStr < dateRange.startDate || dateStr > dateRange.endDate)
      ) {
        continue;
      }

      const won = isOpportunityWon(opp);
      const stageName =
        opp.stageName ??
        (opp.pipelineStageId
          ? stageIdToName.get(opp.pipelineStageId as string)
          : null) ??
        (opp.pipelineStageId as string) ??
        "Unknown";

      const val = getOppMonetaryValue(opp);
      if (won) {
        aggregateCounts[STATUS_WON_KEY] = (aggregateCounts[STATUS_WON_KEY] ?? 0) + 1;
        aggregateValues[STATUS_WON_KEY] =
          (aggregateValues[STATUS_WON_KEY] ?? 0) + val;
      } else {
        aggregateCounts[stageName] = (aggregateCounts[stageName] ?? 0) + 1;
        aggregateValues[stageName] = (aggregateValues[stageName] ?? 0) + val;
      }

      const bucket = classifyOpportunityFunnelBucket({
        isWon: won,
        stageName,
        pipelineStages,
        customMappings,
      });

      const cid =
        (opp.contactId as string) ??
        ((opp as Record<string, unknown>).contact_id as string) ??
        null;

      inRange.push({
        contactId: cid,
        name:
          ((opp.name as string) ??
            ((opp as Record<string, unknown>).opportunityName as string) ??
            `Opportunity ${opp.id}`) || `Opportunity ${opp.id}`,
        value: val,
        bucket,
        stageName,
      });
    }

    if (opportunities.length < limit) break;
    if (total > 0 && page * limit >= total) break;
    page += 1;
  }

  const uniqueContactIds = [
    ...new Set(
      inRange.map((r) => r.contactId).filter((id): id is string => !!id)
    ),
  ];

  const contactMap = await fetchContactsSequential(
    accessToken,
    uniqueContactIds,
    locationId
  );

  const agg = new Map<string, RowAgg>();

  const emptyFields: ContactAttributionFields = {
    utmSource: "",
    utmMedium: "",
    utmContent: "",
    utmCampaign: "",
  };

  for (const row of inRange) {
    const parsed = row.contactId ? contactMap.get(row.contactId) : null;
    const fields = parsed?.fields ?? emptyFields;
    const metaIds = parsed?.metaIds ?? EMPTY_META_IDS;

    const key = resolveAttributionKey(dimension, fields);
    let acc = agg.get(key);
    if (!acc) {
      acc = emptyRowAgg();
      agg.set(key, acc);
    }
    addToRow(acc, row.bucket, row.value);
    addMetaIdsToRow(acc, metaIds);
    acc.contacts.push({
      contactId: row.contactId,
      name: row.name,
      bucket: row.bucket,
      stageName: row.stageName,
      value: Math.round(row.value * 100) / 100,
      attribution: fields,
      metaIds,
    });
  }

  const rows = [...agg.entries()]
    .map(([key, row]) => finalizeRow(key, row, dimension))
    .sort((a, b) => b.closed - a.closed || b.total - a.total);

  const closedInRange = inRange.filter((r) => r.bucket === "closed").length;
  const funnelMetrics = calculateFunnelMetrics(
    aggregateCounts,
    aggregateValues,
    pipelineStages,
    customMappings
  );
  const funnelClosedAggregate = funnelMetrics.closed;
  const closedMatchesFunnelAggregate =
    closedInRange === funnelClosedAggregate;

  return {
    rows,
    meta: {
      opportunitiesInRange: inRange.length,
      closedInRange,
      funnelClosedAggregate,
      closedMatchesFunnelAggregate,
      contactsFetched: uniqueContactIds.length,
      dimension,
    },
  };
}
