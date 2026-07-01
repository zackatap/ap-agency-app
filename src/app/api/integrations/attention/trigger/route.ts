import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type AttentionWorkflowScope = "flagged" | "red";

/** Query string for GET /api/integrations/attention that Zapier step 2 should use. */
export function attentionQueryForScope(scope: AttentionWorkflowScope): string {
  return scope === "red" ? "flagged=1&urgency=0" : "flagged=1";
}

function parseScope(raw: string | null): AttentionWorkflowScope | null {
  if (raw === "flagged" || raw === "all") return "flagged";
  if (raw === "red") return "red";
  return null;
}

/**
 * Manually kick off the Zapier attention workflow by POSTing to a Catch Hook
 * URL. The hook payload includes `attentionQuery` so Zapier step 2 can call
 * GET /api/integrations/attention?{{attentionQuery}} with the chosen scope.
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
  if (!scope) {
    try {
      const body = (await req.json()) as { scope?: string };
      scope = parseScope(body.scope ?? null);
    } catch {
      // Empty body → default to all flagged (matches Monday schedule).
    }
  }
  const resolved: AttentionWorkflowScope = scope ?? "flagged";
  const attentionQuery = attentionQueryForScope(resolved);

  try {
    const res = await fetch(hookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        triggeredAt: new Date().toISOString(),
        scope: resolved,
        attentionQuery,
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

    return NextResponse.json({ ok: true, scope: resolved, attentionQuery });
  } catch (err) {
    console.error("[integrations/attention/trigger]", err);
    const message = err instanceof Error ? err.message : "Hook request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
