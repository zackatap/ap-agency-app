/**
 * Inspect raw GHL contact JSON + how we parse UTMs (debug only).
 *
 * GET /api/debug/ghl-contact/[locationId]?contactId=xxx
 */

import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import {
  extractContactAttributionFromContactJson,
} from "@/lib/ghl-attribution";
import { ghlAuthHeaders } from "@/lib/ghl-oauth";

const GHL_BASE = "https://services.leadconnectorhq.com";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    const { searchParams } = new URL(req.url);
    const contactId = searchParams.get("contactId")?.trim();

    if (!locationId || !contactId) {
      return NextResponse.json(
        { error: "locationId and contactId query params are required" },
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

    const url = new URL(`${GHL_BASE}/contacts/${contactId}`);
    url.searchParams.set("location_id", locationId);

    const res = await fetch(url.toString(), {
      headers: ghlAuthHeaders(stored.access_token),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          error: "GHL returned non-JSON",
          status: res.status,
          snippet: text.slice(0, 800),
        },
        { status: 502 }
      );
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: "GHL request failed", status: res.status, body: json },
        { status: res.status }
      );
    }

    const record = json as Record<string, unknown>;
    const extracted = extractContactAttributionFromContactJson(record);

    return NextResponse.json({
      contactId,
      explanation: {
        source:
          "We read contact.attributionSource (then other nested blocks, then customFields for gaps only). No opportunity source or opportunity UTM fallbacks.",
        campaign: "utmCampaign + `campaign` from those objects → Campaign column.",
        adSet: "utmMedium → Ad set column.",
        ad: "utmContent → Ad column.",
      },
      extracted,
      raw: json,
    });
  } catch (err) {
    console.error("[debug/ghl-contact]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
