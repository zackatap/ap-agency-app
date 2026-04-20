/**
 * POST /api/agency/client-locations/lookup
 *
 * Geocode an ad-hoc prospective-client address so the agency can plot it on
 * the client map to see how it overlaps with existing territory. Single
 * address per call — reuses the geocode cache, so repeat lookups are free.
 */
import { NextResponse, type NextRequest } from "next/server";
import { geocodeAddresses } from "@/lib/geocoding";

export const dynamic = "force-dynamic";

export interface ProspectLookupResponse {
  address: string;
  lat: number | null;
  lng: number | null;
  error: string | null;
}

export async function POST(req: NextRequest) {
  let body: { address?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Empty / invalid JSON — fall through to the address validation below.
  }
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address) {
    return NextResponse.json<ProspectLookupResponse>(
      {
        address: "",
        lat: null,
        lng: null,
        error: "Address is required",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Always retry cached errors for prospect lookups — the user is actively
  // waiting on a result, so healing any previously-cached failure is worth
  // the single extra Nominatim call.
  const { results } = await geocodeAddresses([address], {
    maxNewGeocodes: 1,
    retryCachedErrors: true,
  });
  const result = results.get(address) ?? results.get(address.trim());

  return NextResponse.json<ProspectLookupResponse>(
    {
      address,
      lat: result?.lat ?? null,
      lng: result?.lng ?? null,
      error: result?.error ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
