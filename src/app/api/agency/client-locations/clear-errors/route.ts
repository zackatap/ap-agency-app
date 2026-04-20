/**
 * POST /api/agency/client-locations/clear-errors
 *
 * Deletes every row in `geocode_cache` where geocoding previously failed.
 * Useful after fixing a systemic issue (bad User-Agent header, outage,
 * dropped network) that poisoned the cache — clearing the errors lets the
 * next map load re-attempt those addresses from scratch.
 */
import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

export async function POST() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }
  const sql = neon(url);
  await sql`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      address_key TEXT PRIMARY KEY,
      address_raw TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      error TEXT,
      geocoded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  const rows = (await sql`
    DELETE FROM geocode_cache WHERE error IS NOT NULL RETURNING address_key
  `) as Array<{ address_key: string }>;
  return NextResponse.json(
    { cleared: rows.length },
    { headers: { "Cache-Control": "no-store" } }
  );
}
