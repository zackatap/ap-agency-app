import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode } from "granola-api";
import { getGranolaRedirectUri } from "@/lib/granola-service";
import { saveGranolaTokens } from "@/lib/granola-tokens";
import {
  GRANOLA_CLIENT_COOKIE,
  GRANOLA_STATE_COOKIE,
  GRANOLA_VERIFIER_COOKIE,
} from "@/lib/granola-oauth-cookies";

function appOrigin(): string {
  return getGranolaRedirectUri().replace(/\/api\/agency\/granola\/callback$/, "");
}

export async function GET(req: NextRequest) {
  const origin = appOrigin();
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      new URL(
        `/agency/content-ideas?error=${encodeURIComponent(oauthError)}`,
        origin
      )
    );
  }

  const expectedState = req.cookies.get(GRANOLA_STATE_COOKIE)?.value;
  const codeVerifier = req.cookies.get(GRANOLA_VERIFIER_COOKIE)?.value;
  const clientId = req.cookies.get(GRANOLA_CLIENT_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(
      new URL("/agency/content-ideas?error=invalid_oauth_state", origin)
    );
  }
  if (!codeVerifier || !clientId) {
    return NextResponse.redirect(
      new URL("/agency/content-ideas?error=missing_oauth_session", origin)
    );
  }

  try {
    const redirectUri = getGranolaRedirectUri();
    const tokens = await exchangeCode({
      clientId,
      code,
      redirectUri,
      codeVerifier,
    });

    await saveGranolaTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      clientId,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });

    const res = NextResponse.redirect(
      new URL("/agency/content-ideas?connected=1", origin)
    );
    res.cookies.delete(GRANOLA_STATE_COOKIE);
    res.cookies.delete(GRANOLA_VERIFIER_COOKIE);
    res.cookies.delete(GRANOLA_CLIENT_COOKIE);
    return res;
  } catch (err) {
    console.error("[granola/callback]", err);
    const message = err instanceof Error ? err.message : "OAuth failed";
    return NextResponse.redirect(
      new URL(
        `/agency/content-ideas?error=${encodeURIComponent(message)}`,
        origin
      )
    );
  }
}
