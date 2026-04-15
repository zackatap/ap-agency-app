import { NextResponse } from "next/server";
import { deleteToken } from "@/lib/oauth-tokens";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const locationId = (url.searchParams.get("locationId") ?? "").trim();

  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }

  try {
    await deleteToken(locationId);
  } catch {
    // Continue into auth flow even if delete fails; OAuth callback can still overwrite.
  }

  const target = new URL(`/api/auth/ghl/authorize?locationId=${encodeURIComponent(locationId)}`, url.origin);
  return NextResponse.redirect(target);
}
