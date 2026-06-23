import { NextResponse } from "next/server";
import { buildAttentionFeed } from "@/lib/attention-feed";

export const dynamic = "force-dynamic";

/**
 * Read-only Attention Dashboard feed for Zapier (replaces the "Get Many Rows"
 * read of the sheet). Returns a top-level JSON array — one object per flagged
 * campaign, sorted by urgency — so Zapier treats each as its own item.
 *
 * The payload carries only the fields the ClickUp zap maps, with keys named to
 * match those fields (reason / client / pipeline / status / urgency /
 * client_relationship_id). "status" is the attention flag code (e.g. S_R4).
 *
 * Auth: `Authorization: Bearer <ATTENTION_API_KEY>` or `?token=<key>`.
 * `?flagged=0` returns every campaign instead of only the flagged ones.
 */
export async function GET(req: Request) {
  const secret = process.env.ATTENTION_API_KEY?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "ATTENTION_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const bearer = req.headers.get("authorization");
  const queryToken = url.searchParams.get("token");
  const presented = bearer === `Bearer ${secret}` || queryToken === secret;
  if (!presented) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Defaults to the flagged-only Attention Dashboard view; ?flagged=0 opts out.
  const flaggedParam = url.searchParams.get("flagged");
  const flaggedOnly = !(flaggedParam === "0" || flaggedParam === "false");

  try {
    const feed = await buildAttentionFeed({ flaggedOnly });
    const items = feed.rows.map((r) => ({
      reason: r.reason ?? "",
      client: r.client_name ?? "",
      pipeline: r.pipeline_name ?? "",
      status: r.attention_code ?? "",
      urgency: r.urgency ?? null,
      client_relationship_id: r.clickup_relation_id ?? "",
    }));
    return NextResponse.json(items, {
      headers: {
        "Cache-Control": "no-store",
        "X-Snapshot-Id": feed.snapshotId == null ? "" : String(feed.snapshotId),
        "X-Snapshot-Finished": feed.snapshotFinishedAt ?? "",
        "X-Row-Count": String(items.length),
      },
    });
  } catch (err) {
    console.error("[integrations/attention]", err);
    const message = err instanceof Error ? err.message : "Feed build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
