/**
 * Pull every client from the Client Database Google Sheet for the map view.
 *
 * Unlike `listActiveCampaigns` (which returns one record per campaign row for
 * the rollup), this function returns **one record per client** — the map only
 * plots a single pin per business even when a client has ACTIVE + 2ND CMPN
 * rows. We also keep every status value so the UI can offer a status filter.
 *
 * Address columns are located by **header text** (case-insensitive substring
 * match), not fixed indexes — the Client DB sheet's address fields sit past
 * column AO and their exact position has shifted over time.
 */
import { fetchSheetRows } from "@/lib/google-sheets";

const COL_CID = 0; // A
const COL_OWNER_FIRST = 1; // B
const COL_OWNER_LAST = 2; // C
const COL_BUSINESS = 3; // D
const COL_STATUS = 4; // E
const COL_PIPELINE = 8; // I — pipeline name (one per row; a client with
//                             multiple campaign rows will surface each one)
const COL_PACKAGE = 25; // Z — "Package(s) Enrolled" (same per-row semantics
//                              as the pipeline column — one value per row)
const COL_LOCATION_ID = 40; // AO
const COL_RADIUS = 42; // AQ — per-client service-area radius in miles

/** Fallback when column AQ is empty or non-numeric. */
export const DEFAULT_RADIUS_MILES = 10;

export interface ClientLocationRecord {
  /** Stable per-client key; prefers CID, falls back to locationId, then business. */
  clientKey: string;
  cid: string | null;
  locationId: string | null;
  businessName: string | null;
  ownerName: string | null;
  status: string;
  /** All status values that appeared for this client (an owner may be ACTIVE + 2ND CMPN). */
  allStatuses: string[];
  /** Distinct pipeline names (column I) collected across every row for this
   *  client. Preserves first-seen order so the "primary" pipeline displays
   *  first in the popup. */
  pipelines: string[];
  /** Distinct package names (column Z, "Package(s) Enrolled"). Same
   *  dedupe-across-rows semantics as `pipelines`. */
  packages: string[];
  /** Composed single-line address suitable for geocoding. */
  address: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  /** Service-area radius in miles (column AQ). Always populated — falls back
   *  to `DEFAULT_RADIUS_MILES` when the sheet cell is blank/unparseable. */
  radiusMiles: number;
  /** True when the value came from the sheet, false when the default was used. */
  radiusFromSheet: boolean;
}

export interface ClientLocationsResult {
  clients: ClientLocationRecord[];
  totalSheetRows: number;
  /** Distinct status values seen in the sheet — useful for the filter UI. */
  statuses: string[];
  /** Clients missing any address string at all. */
  missingAddressCount: number;
  /** 0-based indexes the loader actually used, for debugging. */
  detectedColumns: {
    street: number;
    city: number;
    region: number;
    postalCode: number;
    country: number;
    fullAddress: number;
  };
  error?: string;
  /** Set when no address-like columns could be detected in the sheet header. */
  addressConfigError?: string;
}

/** Case-insensitive header search — returns the first column whose header
 *  contains ANY of the given patterns. */
function findHeaderIndex(headers: string[], patterns: string[]): number {
  for (let i = 0; i < headers.length; i += 1) {
    const h = String(headers[i] ?? "").trim().toLowerCase();
    if (!h) continue;
    for (const p of patterns) {
      if (h === p.toLowerCase() || h.includes(p.toLowerCase())) return i;
    }
  }
  return -1;
}

function safeString(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

/** Parse the radius cell (column AQ). Cells can be bare numbers ("15"),
 *  suffixed ("15 mi", "15 miles"), or empty — anything unparseable returns
 *  null so the caller can decide whether to fall back to the default. */
function parseRadius(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const match = s.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function buildFullAddress(record: {
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}): string | null {
  const parts = [
    record.street,
    [record.city, record.region].filter(Boolean).join(", "),
    record.postalCode,
    record.country,
  ]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function listClientLocations(): Promise<ClientLocationsResult> {
  // Pull the whole sheet — address columns can live well past AO.
  const { rows, error } = await fetchSheetRows({ columnEnd: "BZ" });
  const emptyColumns = {
    street: -1,
    city: -1,
    region: -1,
    postalCode: -1,
    country: -1,
    fullAddress: -1,
  };
  if (error) {
    return {
      clients: [],
      totalSheetRows: 0,
      statuses: [],
      missingAddressCount: 0,
      detectedColumns: emptyColumns,
      error,
    };
  }

  const headerRow = (rows[0] ?? []).map((c) => String(c ?? ""));
  const dataRows = rows.slice(1);

  // Try a dedicated full-address column first (common in CRMs).
  const colFullAddress = findHeaderIndex(headerRow, [
    "full address",
    "mailing address",
    "location address",
    "business address",
  ]);
  const colStreet = findHeaderIndex(headerRow, [
    "street address",
    "street",
    "address 1",
    "address1",
    "address line 1",
    "address",
  ]);
  const colCity = findHeaderIndex(headerRow, ["city"]);
  const colRegion = findHeaderIndex(headerRow, [
    "state/province",
    "state / province",
    "state",
    "province",
    "region",
  ]);
  const colPostal = findHeaderIndex(headerRow, [
    "zip code",
    "zip",
    "postal code",
    "postal",
  ]);
  const colCountry = findHeaderIndex(headerRow, ["country"]);

  const detectedColumns = {
    street: colStreet,
    city: colCity,
    region: colRegion,
    postalCode: colPostal,
    country: colCountry,
    fullAddress: colFullAddress,
  };

  const hasAnyAddressCol =
    colFullAddress >= 0 ||
    colStreet >= 0 ||
    colCity >= 0 ||
    colRegion >= 0 ||
    colPostal >= 0;

  // Merge rows per client. Keyed by CID when present so ACTIVE + 2ND CMPN
  // owners show up as one pin. When CID is missing we fall back to
  // locationId and finally the business name so nothing silently drops.
  const merged = new Map<string, ClientLocationRecord>();
  const statusSet = new Set<string>();

  for (const row of dataRows) {
    const cid = safeString(row[COL_CID]);
    const locationId = safeString(row[COL_LOCATION_ID]);
    const businessName = safeString(row[COL_BUSINESS]);
    if (!cid && !locationId && !businessName) continue;

    const status = String(row[COL_STATUS] ?? "").trim().toUpperCase();
    if (status) statusSet.add(status);
    const pipeline = safeString(row[COL_PIPELINE]);
    const pkg = safeString(row[COL_PACKAGE]);

    const ownerFirst = safeString(row[COL_OWNER_FIRST]);
    const ownerLast = safeString(row[COL_OWNER_LAST]);
    const ownerName = [ownerFirst, ownerLast].filter(Boolean).join(" ") || null;

    const street = colStreet >= 0 ? safeString(row[colStreet]) : null;
    const city = colCity >= 0 ? safeString(row[colCity]) : null;
    const region = colRegion >= 0 ? safeString(row[colRegion]) : null;
    const postalCode = colPostal >= 0 ? safeString(row[colPostal]) : null;
    const country = colCountry >= 0 ? safeString(row[colCountry]) : null;
    const radiusFromSheetVal = parseRadius(row[COL_RADIUS]);
    const radiusMiles = radiusFromSheetVal ?? DEFAULT_RADIUS_MILES;
    const radiusFromSheet = radiusFromSheetVal != null;
    const fullAddressRaw =
      colFullAddress >= 0 ? safeString(row[colFullAddress]) : null;
    const composed = buildFullAddress({
      street,
      city,
      region,
      postalCode,
      country,
    });
    // Prefer the explicit full-address column when it's non-empty, otherwise
    // build one from the individual parts so the geocoder has the most
    // specific string available.
    const address = fullAddressRaw ?? composed;

    const clientKey =
      cid ?? locationId ?? businessName ?? `row-${merged.size}`;

    const existing = merged.get(clientKey);
    if (existing) {
      // Same client reappearing (second campaign row). Carry over any
      // address / owner / location we didn't have yet and record the status.
      if (status && !existing.allStatuses.includes(status)) {
        existing.allStatuses.push(status);
      }
      if (pipeline && !existing.pipelines.includes(pipeline)) {
        existing.pipelines.push(pipeline);
      }
      if (pkg && !existing.packages.includes(pkg)) {
        existing.packages.push(pkg);
      }
      if (!existing.address && address) {
        existing.address = address;
        existing.street = street;
        existing.city = city;
        existing.region = region;
        existing.postalCode = postalCode;
        existing.country = country;
      }
      // Prefer the sheet-provided radius over the default when a second row
      // finally carries one (or takes a larger explicit value over a smaller
      // one — agencies sometimes list both a 10mi and 25mi campaign).
      if (radiusFromSheet) {
        if (!existing.radiusFromSheet || radiusMiles > existing.radiusMiles) {
          existing.radiusMiles = radiusMiles;
          existing.radiusFromSheet = true;
        }
      }
      if (!existing.ownerName && ownerName) existing.ownerName = ownerName;
      if (!existing.businessName && businessName) {
        existing.businessName = businessName;
      }
      if (!existing.locationId && locationId) existing.locationId = locationId;
      // Prefer ACTIVE as the "primary" display status.
      if (status === "ACTIVE") existing.status = "ACTIVE";
      continue;
    }

    merged.set(clientKey, {
      clientKey,
      cid,
      locationId,
      businessName,
      ownerName,
      status: status || "UNKNOWN",
      allStatuses: status ? [status] : [],
      pipelines: pipeline ? [pipeline] : [],
      packages: pkg ? [pkg] : [],
      address,
      street,
      city,
      region,
      postalCode,
      country,
      radiusMiles,
      radiusFromSheet,
    });
  }

  const clients = [...merged.values()].sort((a, b) => {
    const nameA = (a.businessName ?? a.ownerName ?? a.clientKey).toLowerCase();
    const nameB = (b.businessName ?? b.ownerName ?? b.clientKey).toLowerCase();
    return nameA.localeCompare(nameB);
  });
  const missingAddressCount = clients.filter((c) => !c.address).length;
  const statuses = [...statusSet].sort();

  return {
    clients,
    totalSheetRows: dataRows.length,
    statuses,
    missingAddressCount,
    detectedColumns,
    addressConfigError: hasAnyAddressCol
      ? undefined
      : "No address columns detected in the Client DB sheet. Add a column with a header containing 'Address', 'City', or 'Zip' so the map can plot clients.",
  };
}
