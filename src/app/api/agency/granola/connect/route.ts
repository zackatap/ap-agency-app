import { NextResponse } from "next/server";
import {
  buildAuthorizationUrl,
  generatePKCE,
  generateState,
} from "granola-api";
import {
  ensureGranolaOAuthClientId,
  getGranolaRedirectUri,
} from "@/lib/granola-service";
import {
  GRANOLA_CLIENT_COOKIE,
  GRANOLA_STATE_COOKIE,
  GRANOLA_VERIFIER_COOKIE,
} from "@/lib/granola-oauth-cookies";

export async function GET() {
  try {
    const clientId = await ensureGranolaOAuthClientId();
    const redirectUri = getGranolaRedirectUri();
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = generateState();
    const authUrl = buildAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge,
    });

    const res = NextResponse.redirect(authUrl);
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600,
    };
    res.cookies.set(GRANOLA_STATE_COOKIE, state, cookieOpts);
    res.cookies.set(GRANOLA_VERIFIER_COOKIE, codeVerifier, cookieOpts);
    res.cookies.set(GRANOLA_CLIENT_COOKIE, clientId, cookieOpts);
    return res;
  } catch (err) {
    console.error("[granola/connect]", err);
    const message = err instanceof Error ? err.message : "OAuth start failed";
    return NextResponse.redirect(
      new URL(
        `/agency/content-ideas?error=${encodeURIComponent(message)}`,
        getGranolaRedirectUri().replace(/\/api\/agency\/granola\/callback$/, "")
      )
    );
  }
}
