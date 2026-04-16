/**
 * GHL OAuth 2.0 Callback.
 *
 * We don't force user_type at exchange time — GHL issues the code for a
 * specific installer type (Agency vs Sub-account) based on what the user
 * picked at /oauth/chooselocation. We try Company first (matches the common
 * "agency bulk install" case) and fall back to Location for legacy sub-account
 * installs.
 *
 * Per-scenario storage:
 *   userType=Company, isBulkInstallation=true  → agency token (ghl_agency_tokens)
 *   userType=Company, isBulkInstallation=false → agency token AND best-effort
 *                                                 exchange for state.locationId
 *   userType=Location                          → location token (ghl_oauth_tokens)
 *
 * Docs:
 *  - https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token
 *  - https://marketplace.gohighlevel.com/docs/oauth/AppDistribution
 */

import { NextResponse } from "next/server";
import {
  setAgencyToken,
  setToken,
  getAgencyToken,
  type StoredAgencyToken,
  type StoredToken,
} from "@/lib/oauth-tokens";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TOKEN_URL = `${GHL_BASE}/oauth/token`;
const GHL_LOCATION_TOKEN_URL = `${GHL_BASE}/oauth/locationToken`;
const API_VERSION = "2021-07-28";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  locationId?: string;
  companyId?: string;
  expires_in?: number;
  userType?: "Location" | "Company" | string;
  isBulkInstallation?: boolean;
  scope?: string;
}

interface DecodedState {
  locationId?: string;
  returnTo?: string;
}

function decodeState(state: string | null): DecodedState {
  if (!state) return {};
  const tryParse = (encoded: string, variant: "base64url" | "base64") => {
    try {
      const decoded = Buffer.from(encoded, variant).toString("utf-8");
      return JSON.parse(decoded) as DecodedState;
    } catch {
      return null;
    }
  };
  return (
    tryParse(state, "base64url") ??
    tryParse(state.replace(/-/g, "+").replace(/_/g, "/"), "base64") ??
    {}
  );
}

async function exchangeCode(
  code: string,
  userType: "Company" | "Location"
): Promise<TokenResponse | null> {
  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    user_type: userType,
    redirect_uri: redirectUri,
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
    const text = await res.text().catch(() => "");
    console.info(
      "[oauth-callback] exchange miss",
      JSON.stringify({ userType, status: res.status, body: text.slice(0, 200) })
    );
    return null;
  }
  return (await res.json()) as TokenResponse;
}

async function mintLocationFromAgency(
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
  if (!res.ok) return null;
  const data = (await res.json()) as TokenResponse;
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = decodeState(searchParams.get("state"));

  const base = new URL(req.url).origin;
  const errorUrl = (msg: string) =>
    new URL(`/v2/error?msg=${encodeURIComponent(msg)}`, base);

  if (error) return NextResponse.redirect(errorUrl(error));
  if (!code) return NextResponse.redirect(errorUrl("Missing authorization code"));

  // Try Company first (covers both "Agency & Sub-account" agency installs and
  // "Agency Only" flows, with or without bulk). Fall back to Location for
  // direct sub-account installs.
  let token = await exchangeCode(code, "Company");
  let triedLocationFallback = false;
  if (!token) {
    triedLocationFallback = true;
    token = await exchangeCode(code, "Location");
  }

  if (!token || !token.access_token) {
    return NextResponse.redirect(
      errorUrl(
        "Token exchange failed. Please try connecting again from the HighLevel custom menu."
      )
    );
  }

  const userType = token.userType ?? (triedLocationFallback ? "Location" : "Company");
  const companyId = String(token.companyId ?? "").trim();
  const tokenLocationId = String(token.locationId ?? "").trim();
  const expiresIn = token.expires_in ?? 86400;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  console.info(
    "[oauth-callback] exchange ok",
    JSON.stringify({
      userType,
      isBulkInstallation: token.isBulkInstallation ?? null,
      companyId: companyId || null,
      tokenLocationId: tokenLocationId || null,
      stateLocationId: state.locationId ?? null,
      scope: token.scope ?? null,
    })
  );

  // ---------- Company (agency) token path ----------
  if (userType === "Company") {
    if (!companyId) {
      return NextResponse.redirect(
        errorUrl("Agency token missing companyId — cannot store agency access.")
      );
    }
    await setAgencyToken({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? "",
      companyId,
      isBulkInstallation: Boolean(token.isBulkInstallation),
      expires_at: expiresAt,
    });

    // If the user kicked off OAuth from a specific location dashboard, mint
    // that location's token right now so they land on a ready page. Other
    // locations will lazy-mint on first open.
    if (state.locationId) {
      const agency = await getAgencyToken(companyId);
      if (agency) {
        const minted = await mintLocationFromAgency(agency, state.locationId);
        if (minted) await setToken(state.locationId, minted);
      }
    }

    const destination = state.locationId
      ? `/v2/location/${state.locationId}/dashboard?connected=1&installedAs=agency`
      : (state.returnTo || `/?connected=1&installedAs=agency`);
    return NextResponse.redirect(new URL(destination, base));
  }

  // ---------- Location token path ----------
  if (userType === "Location") {
    const resolvedLocationId = tokenLocationId || state.locationId || "";
    if (!resolvedLocationId) {
      return NextResponse.redirect(
        errorUrl(
          "Sub-account token response missing locationId — reconnect from the location custom menu."
        )
      );
    }
    await setToken(resolvedLocationId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? "",
      locationId: resolvedLocationId,
      companyId: companyId || undefined,
      expires_at: expiresAt,
    });

    return NextResponse.redirect(
      new URL(
        `/v2/location/${resolvedLocationId}/dashboard?connected=1&installedAs=location`,
        base
      )
    );
  }

  return NextResponse.redirect(
    errorUrl(`Unsupported userType returned by GHL: ${userType}`)
  );
}
