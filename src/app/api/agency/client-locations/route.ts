/**
 * GET /api/agency/client-locations
 *
 * Returns every client from the Client DB sheet (one per client), joined with
 * cached lat/lng from the geocode cache. A small number of uncached addresses
 * are geocoded on each call so the cache fills up over time without any one
 * request blocking for too long.
 */
import { NextResponse, type NextRequest } from "next/server";
import { listClientLocations } from "@/lib/agency-client-locations";
import {
  geocodeAddresses,
  getActiveGeocodeProvider,
  type GeocodeProvider,
} from "@/lib/geocoding";

export const dynamic = "force-dynamic";

export interface ClientMapPin {
  clientKey: string;
  cid: string | null;
  locationId: string | null;
  businessName: string | null;
  ownerName: string | null;
  status: string;
  allStatuses: string[];
  /** Pipeline name(s) from Client DB column I. One entry per row, deduped. */
  pipelines: string[];
  /** Package(s) enrolled from Client DB column Z. Same semantics as pipelines. */
  packages: string[];
  address: string | null;
  lat: number | null;
  lng: number | null;
  geocodeError: string | null;
  /** Service-area radius in miles. Always present — uses the sheet value
   *  when available, otherwise the per-client default (10 mi). */
  radiusMiles: number;
  radiusFromSheet: boolean;
}

export interface ClientMapResponse {
  clients: ClientMapPin[];
  statuses: string[];
  stats: {
    total: number;
    withCoords: number;
    missingAddress: number;
    geocodeErrors: number;
    pendingGeocode: number;
    newlyGeocoded: number;
    fromCache: number;
    /** Which provider handled fresh lookups on this request. */
    provider: GeocodeProvider;
  };
  addressConfigError?: string;
  error?: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Allow operators to widen/shrink the per-request geocoding budget via
  // ?maxNewGeocodes=N — handy for backfilling the cache after onboarding a
  // batch of new clients.
  const provider = getActiveGeocodeProvider();
  // Google can comfortably churn through hundreds of addresses per request;
  // Nominatim can't, so we keep its ceiling low. Operators can still override
  // with `?maxNewGeocodes=N`.
  //
  // NOTE: we must check the raw string before coercing — `Number(null)` is
  // `0`, which would otherwise sneak past the bounds check and silently set
  // the budget to zero (every address becomes "skipped"/pending).
  const maxNewRaw = url.searchParams.get("maxNewGeocodes");
  const maxNewParam = maxNewRaw != null ? Number(maxNewRaw) : Number.NaN;
  const defaultBudget = provider === "google" ? 500 : 25;
  const budgetCap = provider === "google" ? 1000 : 100;
  const maxNewGeocodes =
    Number.isFinite(maxNewParam) && maxNewParam >= 0 && maxNewParam <= budgetCap
      ? maxNewParam
      : defaultBudget;
  // `?retryErrors=1` — re-geocode addresses that previously failed (e.g. the
  // cache was poisoned by a bad User-Agent). The backfill button in the UI
  // sets this so one click heals the bad rows.
  const retryCachedErrors = url.searchParams.get("retryErrors") === "1";

  const {
    clients,
    statuses,
    error,
    addressConfigError,
  } = await listClientLocations();

  if (error) {
    const body: ClientMapResponse = {
      clients: [],
      statuses: [],
      stats: {
        total: 0,
        withCoords: 0,
        missingAddress: 0,
        geocodeErrors: 0,
        pendingGeocode: 0,
        newlyGeocoded: 0,
        fromCache: 0,
        provider,
      },
      error,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const addressesToGeocode = clients
    .map((c) => c.address)
    .filter((a): a is string => !!a);

  const { results, newlyGeocoded, fromCache, skipped } = await geocodeAddresses(
    addressesToGeocode,
    { maxNewGeocodes, retryCachedErrors }
  );

  let withCoords = 0;
  let missingAddress = 0;
  let geocodeErrors = 0;
  let pendingPins = 0;

  const pins: ClientMapPin[] = clients.map((c) => {
    if (!c.address) {
      missingAddress += 1;
      return {
        clientKey: c.clientKey,
        cid: c.cid,
        locationId: c.locationId,
        businessName: c.businessName,
        ownerName: c.ownerName,
        status: c.status,
        allStatuses: c.allStatuses,
        pipelines: c.pipelines,
        packages: c.packages,
        address: null,
        lat: null,
        lng: null,
        geocodeError: null,
        radiusMiles: c.radiusMiles,
        radiusFromSheet: c.radiusFromSheet,
      };
    }
    const geo = results.get(c.address);
    const lat = geo?.lat ?? null;
    const lng = geo?.lng ?? null;
    if (lat != null && lng != null) {
      withCoords += 1;
    } else if (geo?.source === "skipped") {
      pendingPins += 1;
    } else if (geo?.error) {
      geocodeErrors += 1;
    }
    return {
      clientKey: c.clientKey,
      cid: c.cid,
      locationId: c.locationId,
      businessName: c.businessName,
      ownerName: c.ownerName,
      status: c.status,
      allStatuses: c.allStatuses,
      pipelines: c.pipelines,
      packages: c.packages,
      address: c.address,
      lat,
      lng,
      geocodeError: geo?.error ?? null,
      radiusMiles: c.radiusMiles,
      radiusFromSheet: c.radiusFromSheet,
    };
  });

  const body: ClientMapResponse = {
    clients: pins,
    statuses,
    stats: {
      total: pins.length,
      withCoords,
      missingAddress,
      geocodeErrors,
      // Prefer the pin-level count so the UI's numbers add up to `total`
      // exactly (skipped-in-batch can under-count when multiple clients
      // share an address). Fall back to the batch count defensively.
      pendingGeocode: pendingPins || skipped,
      newlyGeocoded,
      fromCache,
      provider,
    },
    addressConfigError,
  };

  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
