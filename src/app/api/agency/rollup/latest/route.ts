import { NextResponse } from "next/server";
import { buildAgencyRollupView } from "@/lib/agency-rollup-view";

export async function GET() {
  const view = await buildAgencyRollupView();
  if (!view) {
    return NextResponse.json(
      {
        snapshot: null,
        months: [],
        locations: [],
        message:
          "No rollup snapshot yet — click Refresh data to generate the first one.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
