/**
 * GHL OAuth 2.0 - Authorization entry point.
 *
 * Supports both installer types returned by the GHL marketplace:
 *  - Agency user (bulk install) → user_type=Company, isBulkInstallation=true
 *    Exchanged token authorizes /oauth/locationToken for every installed sub-account.
 *  - Sub-account user → user_type=Location (legacy per-location flow).
 *
 * We send the user to the white-label chooselocation URL
 * (marketplace.leadconnectorhq.com) so WL-domain session cookies are reused and
 * the user isn't prompted to log in again. Using marketplace.gohighlevel.com on
 * a white-label agency causes the "Please login to HighLevel to continue" loop.
 *
 * Docs:
 *  - https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0
 *  - https://marketplace.gohighlevel.com/docs/oauth/AppDistribution
 */

import { NextResponse } from "next/server";

// Default to the white-label host (works for WL + non-WL agencies).
// Override via GHL_OAUTH_BASE if the app is listed as a non-WL public app.
const DEFAULT_CHOOSE_LOCATION =
  "https://marketplace.leadconnectorhq.com/oauth/chooselocation";

// Scopes requested by the consent screen. Keep this minimal — what we actually
// use for dashboards, funnels, workflows, opportunities, plus the agency OAuth
// exchange scopes needed to trade the Company token for Location tokens.
const SCOPES = [
  "opportunities.readonly",
  "contacts.readonly",
  "workflows.readonly",
  "funnels/funnel.readonly",
  "oauth.readonly",
  "oauth.write",
].join(" ");

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // locationId is optional now. When present (Connect clicked from a location
  // dashboard) we use it to redirect back to that dashboard after install.
  // When absent (agency installing standalone), we redirect to a generic post-
  // install page.
  const locationId = searchParams.get("locationId")?.trim() ?? "";
  const returnTo = searchParams.get("returnTo")?.trim() ?? "";

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "GHL_CLIENT_ID and GHL_REDIRECT_URI must be set." },
      { status: 500 }
    );
  }

  // State carries routing info for the callback. Base64url-encoded JSON.
  const state = Buffer.from(
    JSON.stringify({ locationId, returnTo })
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
  });

  const authUrl = `${process.env.GHL_OAUTH_BASE ?? DEFAULT_CHOOSE_LOCATION}?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
