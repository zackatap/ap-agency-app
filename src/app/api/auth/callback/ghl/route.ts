/**
 * GHL OAuth 2.0 Callback - Single Location Flow
 *
 * Exchange authorization code for a Location-level access token.
 * Uses user_type=Location only (sub-account token) - no agency/Company handling.
 *
 * Docs: https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token
 */

import { NextResponse } from "next/server";
import { setToken } from "@/lib/oauth-tokens";

const GHL_BASE = "https://services.leadconnectorhq.com";

function decodeState(state: string | null): string {
  if (!state) return "";
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded) as { locationId?: string };
    return String(parsed?.locationId ?? "").trim();
  } catch {
    try {
      const decoded = Buffer.from(state.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      const parsed = JSON.parse(decoded) as { locationId?: string };
      return String(parsed?.locationId ?? "").trim();
    } catch {
      return "";
    }
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const base = new URL(req.url).origin;
  const errorUrl = (msg: string) => new URL(`/v2/error?msg=${encodeURIComponent(msg)}`, base);

  if (error) {
    return NextResponse.redirect(errorUrl(error));
  }

  if (!code) {
    return NextResponse.redirect(errorUrl("Missing authorization code"));
  }

  const locationId = decodeState(state);
  if (!locationId) {
    return NextResponse.redirect(
      errorUrl("Invalid state — open the app from a GHL sub-account custom menu and try Connect again.")
    );
  }

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(errorUrl("OAuth not configured"));
  }

  // Single path: user_type=Location only (sub-account token)
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    user_type: "Location",
    redirect_uri: redirectUri,
  });

  const tokenRes = await fetch(`${GHL_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return NextResponse.redirect(
      errorUrl(`Token exchange failed: ${errText.slice(0, 120)}`)
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    locationId?: string;
    companyId?: string;
    expires_in?: number;
    userType?: string;
  };

  const accessToken = tokenData.access_token;
  const tokenLocationId = String(tokenData.locationId ?? "").trim();
  if (tokenLocationId && tokenLocationId !== locationId) {
    console.warn(
      "[oauth-callback] Token location mismatch",
      JSON.stringify({
        stateLocationId: locationId,
        tokenLocationId,
      })
    );
  }

  // Bind token storage to the location passed in OAuth state (the location where
  // the user clicked Connect) so subsequent API calls use the same key.
  const resolvedLocationId = locationId;

  if (!accessToken) {
    return NextResponse.redirect(errorUrl("Token response missing access_token"));
  }

  const expiresIn = tokenData.expires_in ?? 86400;
  await setToken(resolvedLocationId, {
    access_token: accessToken,
    refresh_token: tokenData.refresh_token ?? "",
    locationId: tokenLocationId || resolvedLocationId,
    companyId: tokenData.companyId,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  });

  return NextResponse.redirect(
    `${base}/v2/location/${resolvedLocationId}/dashboard?connected=1`
  );
}
