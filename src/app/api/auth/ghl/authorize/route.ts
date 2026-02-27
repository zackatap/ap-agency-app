import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId") ?? "";
  const state = Buffer.from(JSON.stringify({ locationId })).toString("base64url");

  // Use the Installation URL from GHL dashboard (Advanced Settings → Auth → Show)
  // This avoids "Invalid parameter: client_id" - GHL's pre-built URL has the correct format
  const installationUrl = process.env.GHL_INSTALLATION_URL;
  if (installationUrl) {
    const separator = installationUrl.includes("?") ? "&" : "?";
    return NextResponse.redirect(`${installationUrl}${separator}state=${state}`);
  }

  // Fallback: construct URL
  const clientId = process.env.GHL_CLIENT_ID;
  const redirectUri = process.env.GHL_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      {
        error:
          "Set GHL_INSTALLATION_URL (from GHL Auth pane → Show Install Link) " +
          "or GHL_CLIENT_ID and GHL_REDIRECT_URI",
      },
      { status: 500 }
    );
  }

  // Try whitelabel URL for agencies on custom domains (e.g. app.automatedpractice.com)
  const authBase =
    process.env.GHL_OAUTH_BASE ??
    "https://marketplace.gohighlevel.com/oauth/chooselocation";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "opportunities.readonly locations.readonly",
    state,
  });
  const sep = authBase.includes("?") ? "&" : "?";
  return NextResponse.redirect(`${authBase}${sep}${params}`);
}
