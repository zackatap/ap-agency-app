import { NextResponse } from "next/server";
import { setToken } from "@/lib/oauth-tokens";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/v2/error?msg=${encodeURIComponent(error)}`, req.url)
    );
  }
  if (!code) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=Missing+authorization+code", req.url)
    );
  }

  let stateLocationId = "";
  if (state) {
    try {
      // Try base64url first (standard for OAuth), then base64 in case GHL modifies it
      let decodedStr = "";
      try {
        decodedStr = Buffer.from(state, "base64url").toString("utf-8");
      } catch {
        decodedStr = Buffer.from(state.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      }
      const decoded = JSON.parse(decodedStr);
      stateLocationId = (decoded.locationId ?? "").trim();
    } catch {
      /* ignore */
    }
  }

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const clientSecret = process.env.GHL_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=OAuth+not+configured", req.url)
    );
  }

  // Agency bulk install expects user_type "Company"; single location expects "Location".
  type TokenResponse = {
    access_token?: string;
    refresh_token?: string;
    locationId?: string;
    companyId?: string;
    expires_in?: number;
    userType?: string;
  };

  let tokenData: TokenResponse | null = null;
  let lastError = "";

  // Try Location first when we have a locationId in state — get single-location token directly
  // https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token
  const tryLocationFirst = !!stateLocationId;
  const userTypes = tryLocationFirst ? ["Location", "Company"] : ["Company", "Location"];
  for (const userType of userTypes) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: userType,
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

    if (tokenRes.ok) {
      tokenData = await tokenRes.json();
      break;
    }
    lastError = await tokenRes.text();
  }

  if (!tokenData?.access_token) {
    return NextResponse.redirect(
      new URL(`/v2/error?msg=${encodeURIComponent(`Token exchange failed: ${lastError.slice(0, 150)}`)}`, req.url)
    );
  }

  const base = new URL(req.url).origin;

  // Location token: we have locationId, store and redirect
  if (tokenData.locationId) {
    const expiresIn = tokenData.expires_in ?? 86400;
    await setToken(tokenData.locationId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? "",
      locationId: tokenData.locationId,
      companyId: tokenData.companyId,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    });
    return NextResponse.redirect(
      `${base}/v2/location/${tokenData.locationId}/dashboard?connected=1`
    );
  }

  // Company token
  if (tokenData.companyId && tokenData.userType === "Company") {
    const fetchHeaders = {
      Accept: "application/json" as const,
      Authorization: `Bearer ${tokenData.access_token}`,
      Version: API_VERSION,
    };

    // User came from a specific location's Connect button — connect only that one and redirect back
    if (stateLocationId) {
      const locTokenRes = await fetch(`${GHL_BASE}/oauth/locationToken`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: API_VERSION,
          Authorization: `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          companyId: tokenData.companyId,
          locationId: stateLocationId,
        }),
      });
      if (locTokenRes.ok) {
        const locToken = await locTokenRes.json();
        const accessToken = locToken.access_token ?? locToken.locationAccessToken;
        if (accessToken) {
          const expiresIn = locToken.expires_in ?? 86400;
          await setToken(stateLocationId, {
            access_token: accessToken,
            refresh_token: locToken.refresh_token ?? "",
            locationId: stateLocationId,
            companyId: tokenData.companyId,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          });
          return NextResponse.redirect(
            `${base}/v2/location/${stateLocationId}/dashboard?connected=1`
          );
        }
      }
      return NextResponse.redirect(
        new URL(
          `/v2/error?msg=${encodeURIComponent(`Could not connect location ${stateLocationId}`)}`,
          req.url
        )
      );
    }

    // No stateLocationId: user came from marketplace install (no specific location).
    // Skip bulk flow — each sub-account connects when they open the app and click Connect.
    return NextResponse.redirect(
      new URL(
        `/v2/error?msg=${encodeURIComponent("App installed. Open it from a sub-account's custom menu to connect and view the dashboard.")}`,
        req.url
      )
    );
  }

  return NextResponse.redirect(
    new URL(`/v2/error?msg=${encodeURIComponent(`Could not obtain location token. userType=${tokenData?.userType}, companyId=${tokenData?.companyId}, locationId=${tokenData?.locationId}, state=${state}, stateLocationId=${stateLocationId}`)}`, req.url)
  );
}
