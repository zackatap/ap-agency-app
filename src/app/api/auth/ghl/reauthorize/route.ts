import { NextResponse } from "next/server";
import { deleteToken } from "@/lib/oauth-tokens";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const locationId = (url.searchParams.get("locationId") ?? "").trim();

  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }

  const deletedRows = await deleteToken(locationId);
  console.info(
    "[oauth-reauthorize] token reset",
    JSON.stringify({ locationId, deletedRows })
  );

  const target = new URL(`/api/auth/ghl/authorize?locationId=${encodeURIComponent(locationId)}`, url.origin);
  return NextResponse.redirect(target);
}
