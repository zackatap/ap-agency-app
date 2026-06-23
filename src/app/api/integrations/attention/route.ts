import { NextResponse } from "next/server";
import { buildAttentionFeed, ATTENTION_WINDOWS } from "@/lib/attention-feed";

export const dynamic = "force-dynamic";

/**
 * Read-only KPI feed for Zapier (replaces the "Get Many Rows" read of the
 * Attention Dashboard sheet). Returns a top-level JSON array — one object per
 * active/2nd-cmpn campaign — so Zapier treats each as its own item/row.
 *
 * Auth: `Authorization: Bearer <ATTENTION_API_KEY>` or `?token=<key>`.
 * Optional `?window=3|7|30` returns a single window (default: all three).
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

  let windows: number[] | undefined;
  const windowParam = url.searchParams.get("window");
  if (windowParam) {
    const requested = Number(windowParam);
    if (!ATTENTION_WINDOWS.includes(requested as (typeof ATTENTION_WINDOWS)[number])) {
      return NextResponse.json(
        { error: `window must be one of ${ATTENTION_WINDOWS.join(", ")}` },
        { status: 400 }
      );
    }
    windows = [requested];
  }

  try {
    const feed = await buildAttentionFeed({ windows });
    return NextResponse.json(feed.rows, {
      headers: {
        "Cache-Control": "no-store",
        "X-Snapshot-Id": feed.snapshotId == null ? "" : String(feed.snapshotId),
        "X-Snapshot-Finished": feed.snapshotFinishedAt ?? "",
      },
    });
  } catch (err) {
    console.error("[integrations/attention]", err);
    const message = err instanceof Error ? err.message : "Feed build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
