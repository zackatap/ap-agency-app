import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines } from "@/lib/ghl-oauth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
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
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
          },
        }
      );
    }

    const pipelines = await getPipelines(locationId, stored.access_token);

    return NextResponse.json({
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        stages: p.stages,
      })),
    });
  } catch (err) {
    console.error("[pipelines] Error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to fetch pipelines",
      },
      { status: 500 }
    );
  }
}
