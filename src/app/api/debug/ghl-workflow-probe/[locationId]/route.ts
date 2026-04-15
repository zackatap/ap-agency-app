import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { probeWorkflowSources } from "@/lib/ghl-workflows";
import { getPipelines } from "@/lib/ghl-oauth";
import { summarizeGhlJwtForDebug } from "@/lib/ghl-jwt";

/**
 * Self-service: same stored token vs GET /workflows/ (official Workflows API only).
 *
 * - GET /workflows/?locationId=… (camelCase — not in public doc body; validated by API)
 * - GET /workflows/
 *
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  const { locationId } = await params;
  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }

  const stored = await getToken(locationId);
  if (!stored) {
    return NextResponse.json(
      { error: "Not connected", needsAuth: true },
      { status: 401 }
    );
  }

  let pipelinesProbe: { ok: boolean; status: string; pipelineCount?: number; error?: string };
  try {
    const pipelines = await getPipelines(locationId, stored.access_token);
    pipelinesProbe = {
      ok: true,
      status: "ok",
      pipelineCount: pipelines.length,
    };
  } catch (e) {
    pipelinesProbe = {
      ok: false,
      status: "error",
      error: e instanceof Error ? e.message.slice(0, 300) : "pipeline fetch failed",
    };
  }

  const wf = await probeWorkflowSources(locationId, stored.access_token);
  const jwt = summarizeGhlJwtForDebug(stored.access_token);

  return NextResponse.json(
    {
      locationId,
      tokenFingerprint: stored.access_token.slice(-8),
      companyIdFromStore: stored.companyId ?? null,
      jwtSummary: jwt,
      docs: {
        getWorkflow: "https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow",
        workflowsApi: "https://marketplace.gohighlevel.com/docs/ghl/workflows/workflows-api",
        scopes: "https://marketplace.gohighlevel.com/docs/Authorization/Scopes",
      },
      sanity: {
        getPipelinesSameToken: pipelinesProbe,
        note:
          "If pipelines work but both /workflows/ calls fail, the access token is valid for opportunities but not accepted for workflows (scope/installation or GHL-side).",
      },
      results: {
        getWorkflowsWithLocationIdQuery: wf.workflowsWithLocationIdQuery,
        getWorkflowsPlain: wf.workflowsPlain,
      },
      interpretation:
        wf.workflowsWithLocationIdQuery.status === 200 ||
        wf.workflowsPlain.status === 200
          ? "At least one GET /workflows/ variant succeeded."
          : "Both /workflows/ variants failed — confirm Marketplace app includes workflows.readonly for Sub-Account and reinstall; if pipelines work, open a GHL API bug with traceId from snippet.",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
