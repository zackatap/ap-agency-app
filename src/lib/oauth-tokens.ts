/**
 * Store/retrieve OAuth tokens per location using Neon Postgres.
 * Add Neon via Vercel Marketplace (Storage → Neon) - it injects DATABASE_URL.
 *
 * Implements refresh token flow per GHL docs:
 * https://marketplace.gohighlevel.com/docs/oauth/Faqs
 */

import { neon } from "@neondatabase/serverless";

const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

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

/** Refresh access token using GHL OAuth token endpoint */
async function refreshAccessToken(
  locationId: string,
  refreshToken: string,
  companyId?: string
): Promise<StoredToken | null> {
  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    user_type: "Location",
  });

  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    locationId?: string;
    companyId?: string;
    expires_in?: number;
  };

  const accessToken = data.access_token ?? null;
  const newRefresh = data.refresh_token ?? refreshToken;
  if (!accessToken) return null;

  const expiresIn = data.expires_in ?? 86400;
  const token: StoredToken = {
    access_token: accessToken,
    refresh_token: newRefresh,
    locationId: data.locationId ?? locationId,
    companyId: data.companyId ?? companyId,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
  return token;
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
    const now = Date.now() / 1000;
    const bufferSec = 3600; // Consider expired when < 1hr remaining

    if (expiresAt >= now + bufferSec) {
      return {
        access_token: row.access_token as string,
        refresh_token: row.refresh_token as string,
        locationId,
        companyId: row.company_id as string | undefined,
        expires_at: expiresAt,
      };
    }

    // Token expired or expiring soon — try refresh
    const refreshToken = row.refresh_token as string;
    if (!refreshToken) return null;

    const refreshed = await refreshAccessToken(
      locationId,
      refreshToken,
      row.company_id as string | undefined
    );
    if (!refreshed) return null;

    await setToken(locationId, refreshed);
    return refreshed;
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
