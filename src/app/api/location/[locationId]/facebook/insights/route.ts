import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getLocationSettings } from "@/lib/location-settings";
import {
  fetchCampaigns,
  fetchSpendByMonth,
  normalizeAdAccountId,
} from "@/lib/facebook-ads";

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

    const settings = await getLocationSettings(locationId);
    const adAccountId = settings?.facebookAdAccountId;
    if (!adAccountId) {
      return NextResponse.json(
        { spendByMonth: {}, error: "Facebook ad account ID not set. Add it in the Month to Month tab." },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const campaignKeyword = searchParams.get("campaignKeyword")?.trim() ?? "";
    const monthKeysParam = searchParams.get("monthKeys"); // "2024-01,2024-02,..."
    const monthKeys = monthKeysParam
      ? monthKeysParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    if (monthKeys.length === 0) {
      return NextResponse.json(
        { spendByMonth: {}, error: "monthKeys is required (comma-separated YYYY-MM)" },
        { status: 400 }
      );
    }

    const normalizedAccount = normalizeAdAccountId(adAccountId);

    // When no keyword: account-level spend (all campaigns)
    if (!campaignKeyword) {
      const { spendByMonth, error } = await fetchSpendByMonth(
        normalizedAccount,
        false,
        monthKeys
      );
      if (error) {
        return NextResponse.json(
          { spendByMonth: {}, error },
          { status: error.includes("not configured") ? 503 : 400 }
        );
      }
      return NextResponse.json({ spendByMonth });
    }

    // When keyword: filter campaigns by name, aggregate spend
    const { campaigns, error: campaignsError } = await fetchCampaigns(normalizedAccount);
    if (campaignsError) {
      return NextResponse.json(
        { spendByMonth: {}, error: campaignsError },
        { status: campaignsError.includes("not configured") ? 503 : 400 }
      );
    }

    const keywordLower = campaignKeyword.toLowerCase();
    const matchingCampaigns = campaigns.filter((c) =>
      c.name.toLowerCase().includes(keywordLower)
    );

    if (matchingCampaigns.length === 0) {
      const spendByMonth: Record<string, number> = {};
      for (const mk of monthKeys) spendByMonth[mk] = 0;
      return NextResponse.json({ spendByMonth });
    }

    // Fetch spend for each matching campaign and aggregate
    const aggregated: Record<string, number> = {};
    for (const mk of monthKeys) aggregated[mk] = 0;

    for (const campaign of matchingCampaigns) {
      const { spendByMonth, error } = await fetchSpendByMonth(
        campaign.id,
        true,
        monthKeys
      );
      if (error) continue; // skip failed campaigns
      for (const [mk, amount] of Object.entries(spendByMonth)) {
        aggregated[mk] = (aggregated[mk] ?? 0) + amount;
      }
    }

    return NextResponse.json({ spendByMonth: aggregated });
  } catch (err) {
    console.error("[facebook/insights] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch insights" },
      { status: 500 }
    );
  }
}
