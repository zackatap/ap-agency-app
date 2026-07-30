import { NextResponse } from "next/server";
import { buildAttentionFeed } from "@/lib/attention-feed";
import { toZapierAttentionItem } from "@/lib/attention-zapier";

export const dynamic = "force-dynamic";

/**
 * Zapier often pastes a whole `attentionQuery` blob after `?` and then
 * URL-encodes it, so `campaignKey=foo` arrives as a single empty-valued param
 * whose *name* is `campaignKey=foo` (the `=` became part of the key). Same
 * for `flagged=1`. Recover those into real search params.
 */
function attentionSearchParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.searchParams);
  const hasCampaignKey = params.has("campaignKey");
  const hasFlagged = params.has("flagged");
  if (hasCampaignKey || hasFlagged) return params;

  for (const [key, value] of url.searchParams) {
    if (value !== "") continue;
    if (!key.includes("=")) continue;
    try {
      const recovered = new URLSearchParams(key);
      for (const [k, v] of recovered) {
        if (!params.has(k)) params.set(k, v);
      }
    } catch {
      // Ignore unparseable mangled keys.
    }
  }

  // Last resort: whole query string was percent-encoded as one blob.
  if (!params.has("campaignKey") && !params.has("flagged") && url.search.length > 1) {
    try {
      const decoded = decodeURIComponent(url.search.slice(1));
      if (decoded.includes("=") && decoded !== url.search.slice(1)) {
        const recovered = new URLSearchParams(decoded);
        for (const [k, v] of recovered) {
          if (!params.has(k)) params.set(k, v);
        }
      }
    } catch {
      // Ignore bad encoding.
    }
  }

  return params;
}

/**
 * Read-only Attention Dashboard feed for Zapier (replaces the "Get Many Rows"
 * read of the sheet). Returns `{ rows: [...] }` — one object per flagged
 * campaign, sorted by urgency — under a `rows` key so Zapier exposes them as
 * line items the way Google Sheets' "Find Many Rows" did (a bare top-level
 * array only surfaces the first item in the step output). `count` is the total.
 *
 * Each row carries only the fields the ClickUp zap maps, with keys named to
 * match those fields (reason / client / pipeline / status / urgency /
 * client_relationship_id). "status" is the attention flag code (e.g. S_R4).
 *
 * Auth: `Authorization: Bearer <ATTENTION_API_KEY>` or `?token=<key>`.
 * `?flagged=0` returns every campaign instead of only the flagged ones.
 * `?urgency=0` returns only red flags (still requires flagged; use with flagged=1).
 * `?campaignKey=…` returns that one campaign as `{ rows: [item], count: 1 }`.
 *
 * Zapier tip: prefer separate Query String Params (`campaignKey` /
 * `flagged` / `urgency`) over pasting a full `attentionQuery` after `?`.
 * Pasting works for bulk by accident (missing params → default flagged-only)
 * but breaks one-offs when `campaignKey=` gets encoded into the param name.
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
  const params = attentionSearchParams(url);
  const bearer = req.headers.get("authorization");
  const queryToken = params.get("token");
  const presented = bearer === `Bearer ${secret}` || queryToken === secret;
  if (!presented) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const campaignKey = params.get("campaignKey")?.trim() || undefined;
  // Defaults to the flagged-only Attention Dashboard view; ?flagged=0 opts out.
  // A one-off campaignKey always returns that row whether or not it's flagged.
  const flaggedParam = params.get("flagged");
  const flaggedOnly = campaignKey
    ? false
    : !(flaggedParam === "0" || flaggedParam === "false");
  const urgencyRaw = params.get("urgency");
  const urgency =
    urgencyRaw != null && urgencyRaw !== ""
      ? Number.parseInt(urgencyRaw, 10)
      : undefined;

  try {
    const feed = await buildAttentionFeed({
      flaggedOnly,
      campaignKey,
      urgency: Number.isFinite(urgency) ? urgency : undefined,
    });
    const items = feed.rows.map((r) => toZapierAttentionItem(r));
    return NextResponse.json(
      { rows: items, count: items.length },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Snapshot-Id": feed.snapshotId == null ? "" : String(feed.snapshotId),
          "X-Snapshot-Finished": feed.snapshotFinishedAt ?? "",
          "X-Row-Count": String(items.length),
        },
      }
    );
  } catch (err) {
    console.error("[integrations/attention]", err);
    const message = err instanceof Error ? err.message : "Feed build failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
