import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });
  }

  try {
    const sql = neon(url);
    const rows = await sql`
      SELECT location_id, company_id, expires_at, updated_at 
      FROM ghl_oauth_tokens 
      ORDER BY updated_at DESC
    `;
    return NextResponse.json({ 
      count: rows.length, 
      tokens: rows.map(r => ({
        locationId: r.location_id,
        companyId: r.company_id,
        expiresAt: new Date(Number(r.expires_at) * 1000).toISOString(),
        updatedAt: r.updated_at
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
