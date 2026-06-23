/**
 * Resolve the list of "active" agency campaigns from the Client Database Google Sheet.
 *
 * Sheet columns (see google-sheets.ts for detection logic):
 *   A  CID                (client identifier — same CID can span multiple locations)
 *   B  OWNER FIRST NAME
 *   C  OWNER LAST NAME
 *   D  BUSINESS NAME
 *   E  STATUS             (we include "ACTIVE" and "2ND CMPN")
 *   G  AD ACCOUNT ID
 *   I  PIPELINE KEYWORD   (pipeline name in GHL contains this value)
 *   J  CAMPAIGN KEYWORD   (Meta/Facebook campaign name contains this value)
 *   K  TAG FILTER         (GHL opportunity tag this campaign is scoped to)
 *   Z  PACKAGE ENROLLED   (fallback label when pipeline keyword is blank)
 *   AO GHL LOCATION ID
 *
 * One sheet row = one campaign. A single GHL location can appear on multiple
 * rows (one per campaign). Unlike the previous implementation, this function
 * returns one entry per **row** so the rollup can track each campaign
 * separately — a client with ACTIVE + 2ND CMPN gets two entries that can later
 * be rolled up under their shared CID in the UI.
 */

import { fetchSheetRows } from "@/lib/google-sheets";

const COL_CID = 0; // A
const COL_OWNER_FIRST = 1; // B
const COL_OWNER_LAST = 2; // C
const COL_BUSINESS = 3; // D
const COL_STATUS = 4; // E
const COL_AD_ACCOUNT = 6; // G
const COL_PIPELINE_KEYWORD = 8; // I
const COL_CAMPAIGN_KEYWORD = 9; // J
const COL_TAG_FILTER = 10; // K — "Tag Filter (Troy Method Hack)"
const COL_PACKAGE_ENROLLED = 25; // Z
const COL_LOCATION_ID = 40; // AO

/** Status column values that count as an active campaign for the rollup. */
export const ACTIVE_STATUSES = new Set(["ACTIVE", "2ND CMPN"]);

export type CampaignStatus = "ACTIVE" | "2ND CMPN";

/**
 * A single sheet row representing one campaign belonging to one GHL location.
 *
 * NOTE: This used to be called `ActiveClient` and was deduped per-location.
 * The new model treats each sheet row as its own record ("campaign"). The old
 * type name is kept as an alias for backwards compatibility with imports that
 * have not yet been updated.
 */
export interface ActiveCampaign {
  /** Stable identifier: `${locationId}:${pipelineKeyword || status}`. */
  campaignKey: string;
  locationId: string;
  status: CampaignStatus;
  cid: string | null;
  businessName: string | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  /** Column I — GHL pipeline name should contain this value (substring match). */
  pipelineKeyword: string | null;
  /** Column J — Meta campaign name should contain this value (substring match). */
  campaignKeyword: string | null;
  /**
   * Column K — GHL opportunity tag this campaign is scoped to. When two rows
   * share the same pipeline (e.g. Hornback's "Leads" pipeline split into Pain
   * vs Decompression), this tag is what attributes each opportunity to the
   * right campaign. Blank = count every opportunity in the pipeline.
   */
  tagFilter: string | null;
  /** Column Z — display fallback when Column I is blank. */
  packageEnrolled: string | null;
  adAccountId: string | null;
}

/** @deprecated prefer {@link ActiveCampaign}. */
export type ActiveClient = ActiveCampaign;

export interface ActiveCampaignsResult {
  campaigns: ActiveCampaign[];
  /** @deprecated prefer {@link ActiveCampaignsResult.campaigns}. */
  clients: ActiveCampaign[];
  totalSheetRows: number;
  skippedNoLocationId: number;
  skippedInactive: number;
  /** Unique locations covered by the returned campaigns. */
  locationCount: number;
  error?: string;
}

function normalizeStatus(raw: string): string {
  return raw.trim().toUpperCase();
}

function normalizeAdAccount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function safeString(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

function statusPriority(status: CampaignStatus): number {
  // Lower number = higher priority (sorted first).
  return status === "ACTIVE" ? 0 : 1;
}

export async function listActiveCampaigns(): Promise<ActiveCampaignsResult> {
  const { rows, error } = await fetchSheetRows();
  if (error) {
    return {
      campaigns: [],
      clients: [],
      totalSheetRows: 0,
      skippedNoLocationId: 0,
      skippedInactive: 0,
      locationCount: 0,
      error,
    };
  }

  const dataRows = rows.slice(1);
  const campaigns: ActiveCampaign[] = [];
  const seenKeys = new Set<string>();
  const locationIds = new Set<string>();
  let skippedNoLocationId = 0;
  let skippedInactive = 0;

  for (const row of dataRows) {
    const locationId = String(row[COL_LOCATION_ID] ?? "").trim();
    if (!locationId) {
      skippedNoLocationId += 1;
      continue;
    }
    const rawStatus = normalizeStatus(String(row[COL_STATUS] ?? ""));
    if (!ACTIVE_STATUSES.has(rawStatus)) {
      skippedInactive += 1;
      continue;
    }
    const status = rawStatus as CampaignStatus;
    const pipelineKeyword = safeString(row[COL_PIPELINE_KEYWORD]);
    const campaignKeyword = safeString(row[COL_CAMPAIGN_KEYWORD]);
    const tagFilter = safeString(row[COL_TAG_FILTER]);
    const packageEnrolled = safeString(row[COL_PACKAGE_ENROLLED]);
    // Build a key from everything that distinguishes one campaign row from
    // another at the same location: pipeline keyword, Meta keyword, tag filter,
    // and status. Two rows sharing a pipeline (Hornback's "Leads" split into
    // Pain vs Decompression) differ on the Meta keyword + tag filter, so they
    // get distinct keys instead of collapsing into one. The old scheme keyed on
    // pipeline keyword alone and silently dropped the second row.
    const parts = [pipelineKeyword, campaignKeyword, tagFilter, status]
      .map((p) => (p ?? "").trim().toLowerCase())
      .filter(Boolean);
    let campaignKey = `${locationId}:${parts.join("|") || status.toLowerCase()}`;
    // Last-resort guard for genuinely identical rows — keep both rather than
    // discard one.
    if (seenKeys.has(campaignKey)) {
      let n = 2;
      while (seenKeys.has(`${campaignKey}#${n}`)) n += 1;
      campaignKey = `${campaignKey}#${n}`;
    }
    seenKeys.add(campaignKey);
    locationIds.add(locationId);

    campaigns.push({
      campaignKey,
      locationId,
      status,
      cid: safeString(row[COL_CID]),
      businessName: safeString(row[COL_BUSINESS]),
      ownerFirstName: safeString(row[COL_OWNER_FIRST]),
      ownerLastName: safeString(row[COL_OWNER_LAST]),
      pipelineKeyword,
      campaignKeyword,
      tagFilter,
      packageEnrolled,
      adAccountId: normalizeAdAccount(String(row[COL_AD_ACCOUNT] ?? "")),
    });
  }

  // ACTIVE before 2ND CMPN within the same location, then alphabetical.
  campaigns.sort((a, b) => {
    if (a.locationId === b.locationId) {
      return statusPriority(a.status) - statusPriority(b.status);
    }
    const nameA = (a.businessName ?? a.locationId).toLowerCase();
    const nameB = (b.businessName ?? b.locationId).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return {
    campaigns,
    clients: campaigns,
    totalSheetRows: dataRows.length,
    skippedNoLocationId,
    skippedInactive,
    locationCount: locationIds.size,
  };
}

/** @deprecated prefer {@link listActiveCampaigns}. */
export const listActiveClients = listActiveCampaigns;
