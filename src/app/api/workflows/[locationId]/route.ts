import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getWorkflowCampaigns } from "@/lib/ghl-workflows";

function buildWorkflowUrl(locationId: string, workflowId: string): string {
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/automation/workflows/${encodeURIComponent(workflowId)}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

function extractTokenLocation(claims: Record<string, unknown> | null): string {
  if (!claims) return "";
  return String(
    claims.locationId ??
      claims.location_id ??
      claims.subAccountId ??
      claims.sub_account_id ??
      ""
  ).trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  let requestedLocationId = "";
  let tokenLocationId = "";
  let tokenCompanyId: string | null = null;
  let tokenFingerprint: string | null = null;

  try {
    const { locationId } = await params;
    requestedLocationId = locationId;
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

    const tokenClaims = decodeJwtPayload(stored.access_token);
    tokenLocationId = extractTokenLocation(tokenClaims);
    tokenCompanyId = stored.companyId ?? null;
    tokenFingerprint = stored.access_token.slice(-8);
    if (tokenLocationId && tokenLocationId !== locationId) {
      console.warn(
        "[workflows] token/location mismatch (pre-request)",
        JSON.stringify({
          requestedLocationId: locationId,
          tokenLocationId,
          tokenFingerprint,
          companyId: tokenCompanyId,
        })
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
      lowered.includes("token does not have access to this location") ||
      (lowered.includes("get /workflows/") &&
        lowered.includes("403") &&
        lowered.includes("access to this location"));

    if (tokenLocationDenied) {
      return NextResponse.json(
        {
          error:
            "Token is not authorized for this location. Please reconnect this location from Customizer.",
          needsAuth: true,
          debugHint:
            "If this persists after reconnect, token may be tied to a different sub-account than the URL location.",
          debug: {
            requestedLocationId: requestedLocationId || null,
            tokenLocationId: tokenLocationId || null,
            companyId: tokenCompanyId,
            tokenFingerprint,
          },
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
