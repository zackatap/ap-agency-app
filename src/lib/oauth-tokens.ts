/**
 * Store/retrieve OAuth tokens (Neon Postgres).
 *
 * Two token shapes:
 *  - Location tokens (ghl_oauth_tokens)     → keyed by location_id
 *  - Agency/Company tokens (ghl_agency_tokens) → keyed by company_id, used to
 *    mint Location tokens on demand for bulk-installed sub-accounts via
 *    POST /oauth/locationToken.
 *
 * Resolution order for getToken(locationId):
 *   1. Cached location token (refresh if near expiry)
 *   2. Any cached agency token → trade for a location token → cache it
 *   3. null → caller shows the "Install" CTA
 *
 * Refresh tokens expire 1 year after last use. Access tokens are ~24h.
 * Docs: https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0
 */

import { neon } from "@neondatabase/serverless";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TOKEN_URL = `${GHL_BASE}/oauth/token`;
const GHL_LOCATION_TOKEN_URL = `${GHL_BASE}/oauth/locationToken`;
const API_VERSION = "2021-07-28";

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  locationId: string;
  companyId?: string;
  expires_at: number;
}

export interface StoredAgencyToken {
  access_token: string;
  refresh_token: string;
  companyId: string;
  isBulkInstallation: boolean;
  expires_at: number;
}

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

// ----------------- schema bootstrap -----------------

// Avoid re-running CREATE TABLE every call within a warm serverless instance.
let locationTableReady = false;
let agencyTableReady = false;

type Sql = NonNullable<ReturnType<typeof getDb>>;

async function ensureLocationTable(sql: Sql): Promise<void> {
  if (locationTableReady) return;
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
  locationTableReady = true;
}

async function ensureAgencyTable(sql: Sql): Promise<void> {
  if (agencyTableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS ghl_agency_tokens (
      company_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      is_bulk_installation BOOLEAN DEFAULT FALSE,
      expires_at BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  agencyTableReady = true;
}

// ----------------- refresh helpers -----------------

async function refreshToken(
  refreshTokenValue: string,
  userType: "Location" | "Company"
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  locationId?: string;
  companyId?: string;
  userType?: string;
  isBulkInstallation?: boolean;
} | null> {
  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    user_type: userType,
  });

  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    console.warn(
      "[oauth-tokens] refresh failed",
      res.status,
      await res.text().catch(() => "")
    );
    return null;
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    locationId?: string;
    companyId?: string;
    userType?: string;
    isBulkInstallation?: boolean;
  };
  if (!data.access_token || !data.refresh_token) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    locationId: data.locationId,
    companyId: data.companyId,
    userType: data.userType,
    isBulkInstallation: data.isBulkInstallation,
  };
}

// ----------------- agency-token → location-token exchange -----------------

/**
 * Use a stored agency (Company) token to mint a location token via
 * POST /oauth/locationToken. Returns null if the agency doesn't own this
 * location, or the call fails.
 *
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/oauth/get-location-access-token
 */
async function mintLocationTokenFromAgency(
  agency: StoredAgencyToken,
  locationId: string
): Promise<StoredToken | null> {
  const body = new URLSearchParams({
    companyId: agency.companyId,
    locationId,
  });

  const res = await fetch(GHL_LOCATION_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${agency.access_token}`,
      Version: API_VERSION,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    console.info(
      "[oauth-tokens] locationToken exchange miss",
      JSON.stringify({
        companyId: agency.companyId,
        locationId,
        status: res.status,
      })
    );
    return null;
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    locationId?: string;
    companyId?: string;
  };

  if (!data.access_token) return null;
  const expiresIn = data.expires_in ?? 86400;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? "",
    locationId: data.locationId ?? locationId,
    companyId: data.companyId ?? agency.companyId,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

// ----------------- public: agency tokens -----------------

export async function setAgencyToken(token: StoredAgencyToken): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  try {
    await ensureAgencyTable(sql);
    await sql`
      INSERT INTO ghl_agency_tokens (
        company_id, access_token, refresh_token, is_bulk_installation, expires_at
      )
      VALUES (
        ${token.companyId}, ${token.access_token}, ${token.refresh_token},
        ${token.isBulkInstallation}, ${token.expires_at}
      )
      ON CONFLICT (company_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        is_bulk_installation = EXCLUDED.is_bulk_installation,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
  } catch (err) {
    console.error("[oauth-tokens] setAgencyToken error:", err);
    throw err;
  }
}

export async function getAgencyToken(
  companyId: string
): Promise<StoredAgencyToken | null> {
  const sql = getDb();
  if (!sql) return null;
  try {
    await ensureAgencyTable(sql);
    const rows = await sql`
      SELECT access_token, refresh_token, is_bulk_installation, expires_at
      FROM ghl_agency_tokens
      WHERE company_id = ${companyId}
    `;
    const row = rows[0];
    if (!row) return null;

    const expiresAt = Number(row.expires_at);
    const now = Date.now() / 1000;
    const bufferSec = 3600;

    const stored: StoredAgencyToken = {
      access_token: row.access_token as string,
      refresh_token: row.refresh_token as string,
      isBulkInstallation: Boolean(row.is_bulk_installation),
      companyId,
      expires_at: expiresAt,
    };

    if (expiresAt >= now + bufferSec) return stored;

    // Refresh.
    if (!stored.refresh_token) return null;
    const refreshed = await refreshToken(stored.refresh_token, "Company");
    if (!refreshed) return null;

    const expiresIn = refreshed.expires_in ?? 86400;
    const updated: StoredAgencyToken = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      companyId: refreshed.companyId ?? companyId,
      isBulkInstallation:
        refreshed.isBulkInstallation ?? stored.isBulkInstallation,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
    await setAgencyToken(updated);
    return updated;
  } catch (err) {
    console.error("[oauth-tokens] getAgencyToken error:", err);
    return null;
  }
}

/** Return every agency token we have stored (rarely more than a handful). */
export async function listAgencyTokens(): Promise<StoredAgencyToken[]> {
  const sql = getDb();
  if (!sql) return [];
  try {
    await ensureAgencyTable(sql);
    const rows = await sql`
      SELECT company_id, access_token, refresh_token, is_bulk_installation, expires_at
      FROM ghl_agency_tokens
      ORDER BY updated_at DESC NULLS LAST
    `;
    return rows.map((r) => ({
      companyId: r.company_id as string,
      access_token: r.access_token as string,
      refresh_token: r.refresh_token as string,
      isBulkInstallation: Boolean(r.is_bulk_installation),
      expires_at: Number(r.expires_at),
    }));
  } catch (err) {
    console.error("[oauth-tokens] listAgencyTokens error:", err);
    return [];
  }
}

export async function deleteAgencyToken(companyId: string): Promise<number> {
  const sql = getDb();
  if (!sql) return 0;
  try {
    await ensureAgencyTable(sql);
    const result = await sql`
      DELETE FROM ghl_agency_tokens WHERE company_id = ${companyId}
    `;
    return Array.isArray(result) ? result.length : 0;
  } catch (err) {
    console.error("[oauth-tokens] deleteAgencyToken error:", err);
    throw err;
  }
}

// ----------------- public: location tokens -----------------

export async function setToken(
  locationId: string,
  token: StoredToken
): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  try {
    await ensureLocationTable(sql);
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

export async function deleteToken(locationId: string): Promise<number> {
  const sql = getDb();
  if (!sql) return 0;
  try {
    await ensureLocationTable(sql);
    const result = await sql`
      DELETE FROM ghl_oauth_tokens WHERE location_id = ${locationId}
    `;
    return Array.isArray(result) ? result.length : 0;
  } catch (err) {
    console.error("[oauth-tokens] deleteToken error:", err);
    throw err;
  }
}

/**
 * Resolve a Location token for the given locationId.
 * 1. Cached location token (auto-refresh if expiring).
 * 2. Agency-token exchange against every known agency until one succeeds.
 * 3. null → caller should show Install CTA.
 */
export async function getToken(
  locationId: string
): Promise<StoredToken | null> {
  const sql = getDb();
  if (!sql) return null;

  try {
    await ensureLocationTable(sql);
    const rows = await sql`
      SELECT access_token, refresh_token, company_id, expires_at
      FROM ghl_oauth_tokens
      WHERE location_id = ${locationId}
    `;
    const row = rows[0];

    if (row) {
      const expiresAt = Number(row.expires_at);
      const now = Date.now() / 1000;
      const bufferSec = 3600;

      if (expiresAt >= now + bufferSec) {
        return {
          access_token: row.access_token as string,
          refresh_token: row.refresh_token as string,
          locationId,
          companyId: row.company_id as string | undefined,
          expires_at: expiresAt,
        };
      }

      // Expired/expiring — attempt refresh when we still have a refresh_token.
      const cachedRefresh = row.refresh_token as string;
      if (cachedRefresh) {
        const refreshed = await refreshToken(cachedRefresh, "Location");
        if (refreshed) {
          const expiresIn = refreshed.expires_in ?? 86400;
          const updated: StoredToken = {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            locationId: refreshed.locationId ?? locationId,
            companyId:
              refreshed.companyId ?? (row.company_id as string | undefined),
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          };
          await setToken(locationId, updated);
          return updated;
        }
      }

      // Refresh failed but we may know the company — try agency exchange with
      // just that agency first.
      const knownCompanyId = (row.company_id as string | undefined) ?? null;
      if (knownCompanyId) {
        const agency = await getAgencyToken(knownCompanyId);
        if (agency) {
          const minted = await mintLocationTokenFromAgency(agency, locationId);
          if (minted) {
            await setToken(locationId, minted);
            return minted;
          }
        }
      }
    }

    // No cached location token (or refresh failed). Try every agency we have.
    const agencies = await listAgencyTokens();
    for (const agency of agencies) {
      // Re-fetch through getAgencyToken to pick up any auto-refresh.
      const fresh = await getAgencyToken(agency.companyId);
      if (!fresh) continue;
      const minted = await mintLocationTokenFromAgency(fresh, locationId);
      if (minted) {
        await setToken(locationId, minted);
        return minted;
      }
    }

    return null;
  } catch (err) {
    console.error("[oauth-tokens] getToken error:", err);
    return null;
  }
}
