import { NextResponse, type NextRequest } from "next/server";
import {
  AGENCY_COOKIE_NAME,
  verifyAgencySessionCookie,
} from "@/lib/agency-auth";

/**
 * Guards /agency/* and /api/agency/* routes behind the shared password cookie.
 * Public exceptions: the login page and the login POST endpoint.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname === "/agency/login" ||
    pathname === "/api/agency/auth" ||
    pathname === "/api/agency/auth/logout";

  if (isPublic) return NextResponse.next();

  const cookie = req.cookies.get(AGENCY_COOKIE_NAME)?.value;
  const ok = await verifyAgencySessionCookie(cookie);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const loginUrl = new URL("/agency/login", req.url);
  if (pathname !== "/agency" && pathname !== "/agency/") {
    loginUrl.searchParams.set("next", pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/agency/:path*", "/api/agency/:path*"],
};
