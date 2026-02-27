import { NextResponse } from "next/server";
import { setToken } from "@/lib/oauth-tokens";

const GHL_BASE = "https://services.leadconnectorhq.com";

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

  let locationId = "";
  if (state) {
    try {
      const decoded = JSON.parse(
        Buffer.from(state, "base64url").toString("utf-8")
      );
      locationId = decoded.locationId ?? "";
    } catch {
      /* ignore */
    }
  }

  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  const redirectUri = process.env.GHL_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=OAuth+not+configured", req.url)
    );
  }

  const tokenRes = await fetch(`${GHL_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: "Location",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return NextResponse.redirect(
      new URL(`/v2/error?msg=${encodeURIComponent(`Token exchange failed: ${err.slice(0, 100)}`)}`, req.url)
    );
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const locId = tokenData.locationId ?? locationId;

  if (!accessToken || !locId) {
    return NextResponse.redirect(
      new URL("/v2/error?msg=Invalid+token+response", req.url)
    );
  }

  const expiresIn = tokenData.expires_in ?? 86400;
  await setToken(locId, {
    access_token: accessToken,
    refresh_token: refreshToken ?? "",
    locationId: locId,
    companyId: tokenData.companyId,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  });

  const base = new URL(req.url).origin;
  return NextResponse.redirect(
    `${base}/v2/location/${locId}/dashboard?connected=1`
  );
}
