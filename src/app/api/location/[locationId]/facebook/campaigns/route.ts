import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { fetchCampaigns, normalizeAdAccountId } from "@/lib/facebook-ads";

export async function GET(
  req: Request,
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

    const { searchParams } = new URL(req.url);
    const adAccountId = searchParams.get("adAccountId")?.trim();
    if (!adAccountId) {
      return NextResponse.json(
        { error: "adAccountId is required" },
        { status: 400 }
      );
    }

    const normalized = normalizeAdAccountId(adAccountId);
    const { campaigns, error } = await fetchCampaigns(normalized);

    if (error) {
      return NextResponse.json(
        { campaigns: [], error },
        { status: error.includes("not configured") ? 503 : 400 }
      );
    }

    return NextResponse.json({ campaigns });
  } catch (err) {
    console.error("[facebook/campaigns] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch campaigns" },
      { status: 500 }
    );
  }
}
