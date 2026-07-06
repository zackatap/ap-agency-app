import { NextResponse } from "next/server";
import { refreshCampaignInLatestSnapshot } from "@/lib/agency-rollup-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Re-pull a single campaign's data into the current snapshot. Lets the
 * scorecard's per-account "Retry" fix one errored/timed-out ad account without
 * re-running the whole roster (which would needlessly burn Meta API quota).
 *
 * Runs inline and returns when done so the client can refetch the view.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const campaignKey = searchParams.get("campaignKey");
  if (!campaignKey) {
    return NextResponse.json(
      { error: "campaignKey is required" },
      { status: 400 }
    );
  }

  const result = await refreshCampaignInLatestSnapshot(campaignKey);
  if (result.status === "error") {
    return NextResponse.json(
      { error: result.message ?? "Retry failed" },
      { status: 500 }
    );
  }
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
