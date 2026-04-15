import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getWorkflowCampaigns } from "@/lib/ghl-workflows";

function buildWorkflowUrl(locationId: string, workflowId: string): string {
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/automation/workflows/${encodeURIComponent(workflowId)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") ?? "").trim().toLowerCase();

    if (!locationId) {
      return NextResponse.json(
        { error: "locationId is required" },
        { status: 400 }
      );
    }

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        { status: 401 }
      );
    }

    const allWorkflows = await getWorkflowCampaigns(
      locationId,
      stored.access_token
    );

    const filtered = allWorkflows
      .filter((workflow) =>
        query ? workflow.name.toLowerCase().includes(query) : true
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((workflow) => ({
        ...workflow,
        url: workflow.url ?? buildWorkflowUrl(locationId, workflow.id),
      }));

    return NextResponse.json(
      {
        locationId,
        query,
        count: filtered.length,
        workflows: filtered,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    console.error("[workflows] Error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to fetch workflows";
    const lowered = message.toLowerCase();
    const tokenLocationDenied =
      lowered.includes("does not have access to this location") ||
      lowered.includes("token does not have access to this location");

    if (tokenLocationDenied) {
      return NextResponse.json(
        {
          error:
            "Token is not authorized for this location. Please reconnect this location from Customizer.",
          needsAuth: true,
        },
        { status: 401 }
      );
    }

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
