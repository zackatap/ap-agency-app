/**
 * Resolve the list of "active" agency clients from the Client Database Google Sheet.
 *
 * Sheet columns (see google-sheets.ts for detection logic):
 *   A  CID                (client identifier — same CID can span multiple locations)
 *   B  OWNER FIRST NAME
 *   C  OWNER LAST NAME
 *   D  BUSINESS NAME
 *   E  STATUS             (we include "ACTIVE" and "2ND CMPN")
 *   G  AD ACCOUNT ID
 *   J  CAMPAIGN KEYWORD
 *   AO GHL LOCATION ID
 *
 * A single GHL location can appear on multiple sheet rows (one per campaign).
 * We deduplicate by location ID, marking the location "active" if any of its
 * rows has an accepted status. The first accepted row's display values win.
 */

import { fetchSheetRows } from "@/lib/google-sheets";

const COL_CID = 0; // A
const COL_OWNER_FIRST = 1; // B
const COL_OWNER_LAST = 2; // C
const COL_BUSINESS = 3; // D
const COL_STATUS = 4; // E
const COL_AD_ACCOUNT = 6; // G
const COL_LOCATION_ID = 40; // AO

/** Status column values that count as "active client" for the rollup. */
export const ACTIVE_STATUSES = new Set(["ACTIVE", "2ND CMPN"]);

export interface ActiveClient {
  locationId: string;
  cid: string | null;
  businessName: string | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  /** Every status string seen for this location (deduplicated). */
  statuses: string[];
  adAccountId: string | null;
}

export interface ActiveClientsResult {
  clients: ActiveClient[];
  totalSheetRows: number;
  skippedNoLocationId: number;
  skippedInactive: number;
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

function pickFirst<T>(
  current: T | null,
  candidate: T | null | undefined
): T | null {
  if (current != null && current !== "") return current;
  if (candidate == null) return current;
  const stringValue = String(candidate).trim();
  if (!stringValue) return current;
  return candidate;
}

export async function listActiveClients(): Promise<ActiveClientsResult> {
  const { rows, error } = await fetchSheetRows();
  if (error) {
    return {
      clients: [],
      totalSheetRows: 0,
      skippedNoLocationId: 0,
      skippedInactive: 0,
      error,
    };
  }

  const dataRows = rows.slice(1);
  const byLocation = new Map<string, ActiveClient>();
  let skippedNoLocationId = 0;
  let skippedInactive = 0;

  for (const row of dataRows) {
    const locationId = String(row[COL_LOCATION_ID] ?? "").trim();
    if (!locationId) {
      skippedNoLocationId += 1;
      continue;
    }
    const status = normalizeStatus(String(row[COL_STATUS] ?? ""));
    if (!ACTIVE_STATUSES.has(status)) {
      // Still track for statuses but do not include the location unless at least
      // one of its rows is accepted. We count all non-accepted rows as skipped
      // for diagnostics.
      const existing = byLocation.get(locationId);
      if (existing) {
        if (status && !existing.statuses.includes(status)) {
          existing.statuses.push(status);
        }
      } else {
        skippedInactive += 1;
      }
      continue;
    }

    const existing = byLocation.get(locationId);
    if (existing) {
      if (status && !existing.statuses.includes(status)) {
        existing.statuses.push(status);
      }
      existing.cid = pickFirst(
        existing.cid,
        String(row[COL_CID] ?? "").trim() || null
      );
      existing.businessName = pickFirst(
        existing.businessName,
        String(row[COL_BUSINESS] ?? "").trim() || null
      );
      existing.ownerFirstName = pickFirst(
        existing.ownerFirstName,
        String(row[COL_OWNER_FIRST] ?? "").trim() || null
      );
      existing.ownerLastName = pickFirst(
        existing.ownerLastName,
        String(row[COL_OWNER_LAST] ?? "").trim() || null
      );
      existing.adAccountId = pickFirst(
        existing.adAccountId,
        normalizeAdAccount(String(row[COL_AD_ACCOUNT] ?? ""))
      );
      continue;
    }

    byLocation.set(locationId, {
      locationId,
      cid: String(row[COL_CID] ?? "").trim() || null,
      businessName: String(row[COL_BUSINESS] ?? "").trim() || null,
      ownerFirstName: String(row[COL_OWNER_FIRST] ?? "").trim() || null,
      ownerLastName: String(row[COL_OWNER_LAST] ?? "").trim() || null,
      statuses: status ? [status] : [],
      adAccountId: normalizeAdAccount(String(row[COL_AD_ACCOUNT] ?? "")),
    });
  }

  const clients = [...byLocation.values()].sort((a, b) =>
    (a.businessName ?? a.locationId).localeCompare(
      b.businessName ?? b.locationId
    )
  );

  return {
    clients,
    totalSheetRows: dataRows.length,
    skippedNoLocationId,
    skippedInactive,
  };
}
