import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { probeWorkflowSources } from "@/lib/ghl-workflows";

/**
 * Self-service diagnosis: same token, two official workflow list paths.
 * Open in browser after auth — no secrets returned.
 *
 * - Location list: GET /emails/public/v2/locations/:id/campaigns/workflows
 *   https://marketplace.gohighlevel.com/docs/ghl/emails/list-workflow-campaigns-v-2
 * - Workflows API: GET /workflows/
 *   https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow
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

  const probe = await probeWorkflowSources(locationId, stored.access_token);

  return NextResponse.json(
    {
      locationId,
      tokenFingerprint: stored.access_token.slice(-8),
      companyId: stored.companyId ?? null,
      docs: {
        listWorkflowCampaigns:
          "https://marketplace.gohighlevel.com/docs/ghl/emails/list-workflow-campaigns-v-2",
        getWorkflow: "https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow",
      },
      results: {
        emailsLocationCampaignsWorkflows: probe.locationCampaignsPath,
        workflowsRoot: probe.workflowsRoot,
      },
      interpretation:
        probe.locationCampaignsPath.status === 200
          ? "Use location-scoped list (matches dashboard-style explicit location)."
          : probe.workflowsRoot.status === 200
            ? "Location list failed but GET /workflows/ works — token may lack campaigns.readonly."
            : "Both failed — check Marketplace app scopes (campaigns.readonly + workflows.readonly) and reconnect.",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
