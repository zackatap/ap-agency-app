import { NextResponse } from "next/server";
import { buildAgencyRollupView } from "@/lib/agency-rollup-view";

/**
 * Returns the latest agency rollup plus the requested location's position in it.
 * Used by the "Benchmark" tab embedded in the per-location dashboard. The
 * middleware guards this route behind the agency session cookie so only signed-
 * in team members see benchmark data.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  const { locationId } = await params;
  const view = await buildAgencyRollupView();
  if (!view) {
    return NextResponse.json(
      { view: null, locationId, present: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  const present = view.locations.some((l) => l.locationId === locationId);
  return NextResponse.json(
    { view, locationId, present },
    { headers: { "Cache-Control": "no-store" } }
  );
}
