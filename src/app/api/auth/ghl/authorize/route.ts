/**
 * GHL OAuth 2.0 - Single Location Authorization
 *
 * This app is designed for single-location (sub-account) use:
 * - Embed via GHL Custom Menu with URL: /v2/location/{{location.id}}/dashboard
 * - User opens app from a specific location → we have locationId
 * - Connect flow redirects here with locationId, then to GHL chooselocation
 *
 * GHL Docs: https://marketplace.gohighlevel.com/docs/ghl/oauth/o-auth-2-0
 * Target User Sub-Account: https://marketplace.gohighlevel.com/docs/Authorization/TargetUserSubAccount
 */

import { NextResponse } from "next/server";

const GHL_CHOOSE_LOCATION = "https://marketplace.gohighlevel.com/oauth/chooselocation";

const SCOPES = [
  "opportunities.readonly",
  "locations.readonly",
  "contacts.readonly",
  "oauth.readonly",
  "oauth.write",
].join(" ");

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId")?.trim() ?? "";

  if (!locationId) {
    return NextResponse.json(
      { error: "locationId is required. Open the app from a GHL sub-account custom menu." },
      { status: 400 }
    );
  }

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "GHL_CLIENT_ID and GHL_REDIRECT_URI must be set." },
      { status: 500 }
    );
  }

  // State: base64url-encoded JSON so callback can recover locationId
  const state = Buffer.from(JSON.stringify({ locationId })).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });

  const authUrl = `${process.env.GHL_OAUTH_BASE ?? GHL_CHOOSE_LOCATION}?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
