import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getFunnelsForLocation } from "@/lib/ghl-funnels";

/** White-label funnel builder link (parallel to workflow URLs). Override via NEXT_PUBLIC_GHL_FUNNEL_APP_BASE or NEXT_PUBLIC_GHL_WORKFLOW_APP_BASE. */
function buildFunnelUrl(locationId: string, funnelId: string): string {
  const base = (
    process.env.NEXT_PUBLIC_GHL_FUNNEL_APP_BASE?.trim() ||
    process.env.NEXT_PUBLIC_GHL_WORKFLOW_APP_BASE?.trim() ||
    "https://app.automatedpractice.com"
  ).replace(/\/$/, "");
  return `${base}/location/${encodeURIComponent(locationId)}/funnel/${encodeURIComponent(funnelId)}`;
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
    return JSON.parse(json) as Record<string, unknown>;
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
    const wantDebug =
      searchParams.get("debug") === "1" || searchParams.get("debug") === "true";

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
        "[funnels] token/location mismatch (pre-request)",
        JSON.stringify({
          requestedLocationId: locationId,
          tokenLocationId,
          tokenFingerprint,
          companyId: tokenCompanyId,
        })
      );
    }

    const { funnels: allFunnels, ghlDebug } = await getFunnelsForLocation(
      locationId,
      stored.access_token,
      wantDebug ? { rawSampleLimit: 5 } : undefined
    );

    const filtered = allFunnels
      .filter((funnel) =>
        query ? funnel.name.toLowerCase().includes(query) : true
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((funnel) => ({
        ...funnel,
        url: buildFunnelUrl(locationId, funnel.id),
      }));

    console.info(
      "[funnels] GHL list success",
      JSON.stringify({
        locationId,
        query: query || null,
        totalFromGhl: allFunnels.length,
        returnedAfterFilter: filtered.length,
        sampleNames: filtered.slice(0, 8).map((f) => f.name),
        ghlResponseShape: ghlDebug
          ? {
              requestUrl: ghlDebug.requestUrl,
              totalRecordsFromApi: ghlDebug.totalRecordsFromApi,
              topLevelKeys: ghlDebug.responseTopLevelKeys,
              rawSampleFieldKeys:
                ghlDebug.rawSamples[0] &&
                typeof ghlDebug.rawSamples[0] === "object" &&
                ghlDebug.rawSamples[0] !== null
                  ? Object.keys(
                      ghlDebug.rawSamples[0] as Record<string, unknown>
                    ).sort()
                  : [],
            }
          : undefined,
      })
    );

    return NextResponse.json(
      {
        locationId,
        query,
        count: filtered.length,
        funnels: filtered,
        ...(wantDebug && ghlDebug
          ? {
              ghlAccess: {
                endpoint: "GET /funnels/funnel/list",
                docs: "https://marketplace.gohighlevel.com/docs/ghl/funnels/get-funnels",
                requestUrl: ghlDebug.requestUrl,
                totalRecordsFromApi: ghlDebug.totalRecordsFromApi,
                responseTopLevelKeys: ghlDebug.responseTopLevelKeys,
                rawSamples: ghlDebug.rawSamples,
                normalizedFieldsWeUse: ["id", "name", "status", "url"],
              },
            }
          : {}),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    console.error("[funnels] Error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to fetch funnels";
    const lowered = message.toLowerCase();
    const tokenLocationDenied =
      lowered.includes("does not have access to this location") ||
      lowered.includes("token does not have access to this location") ||
      (lowered.includes("get /funnels/funnel/list") &&
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

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
