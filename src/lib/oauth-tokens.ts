/**
 * Store/retrieve OAuth tokens per location using Neon Postgres.
 * Add Neon via Vercel Marketplace (Storage → Neon) - it injects DATABASE_URL.
 */

import { neon } from "@neondatabase/serverless";

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  locationId: string;
  companyId?: string;
  expires_at: number;
}

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

export async function getToken(
  locationId: string
): Promise<StoredToken | null> {
  const sql = getDb();
  if (!sql) return null;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS ghl_oauth_tokens (
        location_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        company_id TEXT,
        expires_at BIGINT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    const rows = await sql`
      SELECT access_token, refresh_token, company_id, expires_at
      FROM ghl_oauth_tokens
      WHERE location_id = ${locationId}
    `;
    const row = rows[0];
    if (!row) return null;

    const expiresAt = Number(row.expires_at);
    if (expiresAt < Date.now() / 1000 + 3600) {
      return null; // Expiring within 1 hour - need re-auth
    }

    return {
      access_token: row.access_token as string,
      refresh_token: row.refresh_token as string,
      locationId,
      companyId: row.company_id as string | undefined,
      expires_at: expiresAt,
    };
  } catch (err) {
    console.error("[oauth-tokens] getToken error:", err);
    return null;
  }
}

export async function setToken(
  locationId: string,
  token: StoredToken
): Promise<void> {
  const sql = getDb();
  if (!sql) return;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS ghl_oauth_tokens (
        location_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        company_id TEXT,
        expires_at BIGINT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      INSERT INTO ghl_oauth_tokens (location_id, access_token, refresh_token, company_id, expires_at)
      VALUES (${locationId}, ${token.access_token}, ${token.refresh_token}, ${token.companyId ?? null}, ${token.expires_at})
      ON CONFLICT (location_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        company_id = EXCLUDED.company_id,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
  } catch (err) {
    console.error("[oauth-tokens] setToken error:", err);
    throw err;
  }
}
