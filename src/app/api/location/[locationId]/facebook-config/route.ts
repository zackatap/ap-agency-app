import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getLocationFacebookConfig } from "@/lib/google-sheets";

/**
 * GET /api/location/[locationId]/facebook-config
 * Looks up Ad Account ID and Campaign Keyword from the Google Sheet.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    if (!locationId) {
      return NextResponse.json(
        { error: "locationId is required" },
        { status: 400 }
      );
    }

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        { status: 401 }
      );
    }

    const { config, error, debug } = await getLocationFacebookConfig(locationId);

    if (error) {
      return NextResponse.json(
        { config: null, error, debug },
        { status: error.includes("not configured") ? 503 : 500 }
      );
    }

    return NextResponse.json({ config, debug });
  } catch (err) {
    console.error("[facebook-config] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch config" },
      { status: 500 }
    );
  }
}
