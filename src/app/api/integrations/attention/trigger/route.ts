import { NextResponse } from "next/server";
import { buildAttentionFeed } from "@/lib/attention-feed";
import {
  toZapierAttentionItem,
  type ZapierAttentionItem,
} from "@/lib/attention-zapier";

export const dynamic = "force-dynamic";

export type AttentionWorkflowScope = "flagged" | "red" | "single";

/** Query string for GET /api/integrations/attention that Zapier step 2 should use. */
export function attentionQueryForScope(
  scope: AttentionWorkflowScope,
  campaignKey?: string
): string {
  if (scope === "single" && campaignKey) {
    return `campaignKey=${encodeURIComponent(campaignKey)}`;
  }
  return scope === "red" ? "flagged=1&urgency=0" : "flagged=1";
}

function parseScope(raw: string | null): AttentionWorkflowScope | null {
  if (raw === "flagged" || raw === "all") return "flagged";
  if (raw === "red") return "red";
  if (raw === "single") return "single";
  return null;
}

function parsePostToSlack(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * Manually kick off the Zapier attention workflow by POSTing to a Catch Hook
 * URL. The hook payload includes `attentionQuery` so Zapier step 2 can call
 * GET /api/integrations/attention?{{attentionQuery}} with the chosen scope.
 *
 * One-off tasks pass `campaignKey`; Zapier still loops `rows`, which will be a
 * one-item array from the feed. The Catch Hook also includes `rows: [item]` so
 * either wiring works.
 *
 * `postToSlack` (bool) is included on the Catch Hook payload and on each row so
 * the attention zap can, after creating a ClickUp task, call the Slack webhook
 * when the scorecard checkbox was checked.
 *
 * Set ZAPIER_ATTENTION_WEBHOOK_URL to the Catch Hook URL from Zapier.
 */
export async function GET() {
  return NextResponse.json({
    available: Boolean(process.env.ZAPIER_ATTENTION_WEBHOOK_URL?.trim()),
  });
}

export async function POST(req: Request) {
  const hookUrl = process.env.ZAPIER_ATTENTION_WEBHOOK_URL?.trim();
  if (!hookUrl) {
    return NextResponse.json(
      {
        error:
          "ZAPIER_ATTENTION_WEBHOOK_URL is not configured. Add your Zapier Catch Hook URL in env.",
      },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  let scope = parseScope(url.searchParams.get("scope"));
  let campaignKey = url.searchParams.get("campaignKey")?.trim() || null;
  let postToSlack = parsePostToSlack(url.searchParams.get("postToSlack"));

  try {
    const body = (await req.json()) as {
      scope?: string;
      campaignKey?: string;
      postToSlack?: unknown;
    };
    if (!scope) scope = parseScope(body.scope ?? null);
    if (!campaignKey && body.campaignKey?.trim()) {
      campaignKey = body.campaignKey.trim();
    }
    if (body.postToSlack !== undefined) {
      postToSlack = parsePostToSlack(body.postToSlack);
    }
  } catch {
    // Empty body → query params / defaults (matches Monday schedule).
  }

  // campaignKey alone implies a one-off single-row workflow.
  if (campaignKey && (!scope || scope === "flagged")) {
    scope = "single";
  }

  const resolved: AttentionWorkflowScope = scope ?? "flagged";
  if (resolved === "single" && !campaignKey) {
    return NextResponse.json(
      { error: "campaignKey is required for a one-off attention task" },
      { status: 400 }
    );
  }

  const attentionQuery = attentionQueryForScope(
    resolved,
    campaignKey ?? undefined
  );

  // Pre-build the same `{ rows }` shape Zapier step 2 gets from the feed, so a
  // one-off is always a one-item array whether the zap reads the Catch Hook
  // payload or re-fetches via attentionQuery.
  let rows: Array<ZapierAttentionItem & { postToSlack: boolean }> = [];
  if (resolved === "single" && campaignKey) {
    try {
      const feed = await buildAttentionFeed({
        campaignKey,
        flaggedOnly: false,
      });
      rows = feed.rows.map((r) => ({
        ...toZapierAttentionItem(r),
        postToSlack,
      }));
      if (rows.length === 0) {
        return NextResponse.json(
          { error: "Campaign not found in the latest attention feed" },
          { status: 404 }
        );
      }
    } catch (err) {
      console.error("[integrations/attention/trigger] feed", err);
      const message = err instanceof Error ? err.message : "Feed build failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const res = await fetch(hookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: resolved === "single" ? "manual-single" : "manual",
        triggeredAt: new Date().toISOString(),
        scope: resolved,
        attentionQuery,
        postToSlack,
        ...(campaignKey ? { campaignKey } : {}),
        // Same shape as GET /api/integrations/attention — bulk leaves this
        // empty and Zapier fetches via attentionQuery; one-off sends [item].
        ...(rows.length > 0 ? { rows, count: rows.length } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Zapier hook returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      scope: resolved,
      attentionQuery,
      postToSlack,
      ...(campaignKey ? { campaignKey } : {}),
      ...(rows.length > 0 ? { count: rows.length } : {}),
    });
  } catch (err) {
    console.error("[integrations/attention/trigger]", err);
    const message = err instanceof Error ? err.message : "Hook request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
