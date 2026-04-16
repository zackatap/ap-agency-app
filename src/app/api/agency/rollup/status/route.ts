import { NextResponse } from "next/server";
import {
  expireStaleRunningSnapshots,
  getLatestSnapshot,
  listRecentSnapshots,
} from "@/lib/agency-rollup-store";

export async function GET() {
  await expireStaleRunningSnapshots();
  const [latest, recent] = await Promise.all([
    getLatestSnapshot(),
    listRecentSnapshots(10),
  ]);
  return NextResponse.json(
    { latest, recent },
    { headers: { "Cache-Control": "no-store" } }
  );
}
