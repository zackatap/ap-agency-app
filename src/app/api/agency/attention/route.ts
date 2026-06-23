import { NextResponse } from "next/server";
import { buildAttentionFeed } from "@/lib/attention-feed";

export const dynamic = "force-dynamic";

/**
 * Cookie-guarded feed for the in-app Attention Dashboard tab (auth handled by
 * middleware on `/api/agency/*`). Returns flagged campaigns sorted by urgency.
 */
export async function GET() {
  try {
    const feed = await buildAttentionFeed({ flaggedOnly: true });
    return NextResponse.json(feed, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agency/attention]", err);
    const message = err instanceof Error ? err.message : "Feed build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
