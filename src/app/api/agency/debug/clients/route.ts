import { NextResponse } from "next/server";
import { listActiveClients } from "@/lib/agency-clients";
import { fetchSheetRows } from "@/lib/google-sheets";

/**
 * Debug: returns the filtered active-client list exactly as the rollup sees
 * it, plus a sampling of every distinct STATUS value in column E so you can
 * verify the filter matches your expectations before kicking off a real run.
 */
export async function GET() {
  const [{ clients, totalSheetRows, skippedInactive, skippedNoLocationId }, { rows }] =
    await Promise.all([listActiveClients(), fetchSheetRows()]);

  const statusCounts = new Map<string, number>();
  for (const row of rows.slice(1)) {
    const status = String(row[4] ?? "").trim();
    if (!status) continue;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  return NextResponse.json(
    {
      activeClientCount: clients.length,
      totalSheetRows,
      skippedInactive,
      skippedNoLocationId,
      statusBreakdown: Object.fromEntries(
        [...statusCounts.entries()].sort((a, b) => b[1] - a[1])
      ),
      sample: clients.slice(0, 25).map((c) => ({
        locationId: c.locationId,
        businessName: c.businessName,
        cid: c.cid,
        statuses: c.statuses,
        adAccountId: c.adAccountId,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
