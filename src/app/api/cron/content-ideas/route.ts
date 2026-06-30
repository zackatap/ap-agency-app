import { NextResponse } from "next/server";

/** Disabled — content ideas are manual-only via /agency/content-ideas */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    disabled: true,
    message: "Content ideas cron is disabled. Use /agency/content-ideas manually.",
  });
}
