/**
 * Granola OAuth token storage (Neon Postgres).
 * Single workspace user key: "agency".
 */

import { neon } from "@neondatabase/serverless";
import type { GranolaTokens, TokenStore } from "granola-api";

const USER_KEY = "agency";

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

let tableReady = false;

type Sql = NonNullable<ReturnType<typeof getDb>>;

async function ensureTables(sql: Sql): Promise<void> {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS granola_oauth_config (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS granola_tokens (
      user_key TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      client_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  tableReady = true;
}

export async function getGranolaOAuthClientId(): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureTables(sql);
  const rows = await sql`SELECT client_id FROM granola_oauth_config WHERE id = 1 LIMIT 1`;
  return rows[0]?.client_id ?? null;
}

export async function saveGranolaOAuthClientId(
  clientId: string,
  redirectUri: string
): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureTables(sql);
  await sql`
    INSERT INTO granola_oauth_config (id, client_id, redirect_uri)
    VALUES (1, ${clientId}, ${redirectUri})
    ON CONFLICT (id) DO UPDATE SET
      client_id = EXCLUDED.client_id,
      redirect_uri = EXCLUDED.redirect_uri,
      updated_at = NOW()
  `;
}

export async function getStoredGranolaTokens(): Promise<GranolaTokens | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureTables(sql);
  const rows = await sql`
    SELECT access_token, refresh_token, client_id, expires_at
    FROM granola_tokens WHERE user_key = ${USER_KEY} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    accessToken: row.access_token as string,
    refreshToken: row.refresh_token as string,
    clientId: row.client_id as string,
    expiresAt: Number(row.expires_at),
  };
}

export async function saveGranolaTokens(tokens: GranolaTokens): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not configured");
  await ensureTables(sql);
  await sql`
    INSERT INTO granola_tokens (user_key, access_token, refresh_token, client_id, expires_at)
    VALUES (
      ${USER_KEY},
      ${tokens.accessToken},
      ${tokens.refreshToken},
      ${tokens.clientId},
      ${tokens.expiresAt}
    )
    ON CONFLICT (user_key) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      client_id = EXCLUDED.client_id,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
  `;
}

export async function clearGranolaTokens(): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await ensureTables(sql);
  await sql`DELETE FROM granola_tokens WHERE user_key = ${USER_KEY}`;
}

export const granolaTokenStore: TokenStore = {
  async getTokens(userId) {
    if (userId !== USER_KEY) return null;
    return getStoredGranolaTokens();
  },
  async storeTokens(userId, tokens) {
    if (userId !== USER_KEY) return;
    await saveGranolaTokens(tokens);
  },
};

export const GRANOLA_USER_KEY = USER_KEY;
