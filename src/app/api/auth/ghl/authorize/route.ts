import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId") ?? "";
  const state = Buffer.from(JSON.stringify({ locationId })).toString("base64url");

  const clientId = process.env.GHL_CLIENT_ID?.trim();
  const redirectUri = process.env.GHL_REDIRECT_URI?.trim();
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      {
        error:
          "Set GHL_CLIENT_ID and GHL_REDIRECT_URI (and oauth scopes in GHL Auth)",
      },
      { status: 500 }
    );
  }

  // Always use standard OAuth chooselocation URL - it preserves state for Connect flow.
  // Installation URL may not return state (caused iframe locations to stay disconnected).
  const authBase =
    process.env.GHL_OAUTH_BASE ??
    "https://marketplace.gohighlevel.com/oauth/chooselocation";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "opportunities.readonly locations.readonly oauth.readonly oauth.write",
    state,
  });
  const sep = authBase.includes("?") ? "&" : "?";
  return NextResponse.redirect(`${authBase}${sep}${params}`);
}
