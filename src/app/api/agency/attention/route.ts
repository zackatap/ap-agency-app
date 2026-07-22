import { NextResponse } from "next/server";
import { buildAttentionFeed } from "@/lib/attention-feed";

export const dynamic = "force-dynamic";

/**
 * Cookie-guarded feed for the in-app KPI tab (auth handled by middleware on
 * `/api/agency/*`). Returns campaigns flagged by *either* the quantity
 * (lead/CPL) or quality (funnel) engine, sorted by most-urgent flag — so a
 * quality-only client still reaches the Quality column.
 */
export async function GET(req: Request) {
  try {
    // Pass the viewer's tz so flag windows anchor to the same refresh date the
    // KPI table uses (a late-night refresh otherwise lands on the next day).
    const tz = new URL(req.url).searchParams.get("tz") ?? undefined;
    const feed = await buildAttentionFeed({ flaggedMode: "either", tz });
    return NextResponse.json(feed, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agency/attention]", err);
    const message = err instanceof Error ? err.message : "Feed build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
