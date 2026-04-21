import { NextResponse } from "next/server";
import {
  deleteAcceleratorDiscount,
  upsertAcceleratorDiscount,
} from "@/lib/offerings-discounts";
import { verifyAgencySessionCookie } from "@/lib/agency-auth";
import { cookies } from "next/headers";
import { AGENCY_COOKIE_NAME } from "@/lib/agency-auth";

export async function POST(req: Request) {
  const c = await cookies();
  const cookie = c.get(AGENCY_COOKIE_NAME)?.value;
  const ok = await verifyAgencySessionCookie(cookie);
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  try {
    const body = await req.json();
    const { slug, acceleratorPrice, badge } = body;

    if (!slug || !acceleratorPrice || !badge) {
      return new NextResponse("Missing fields", { status: 400 });
    }

    await upsertAcceleratorDiscount({
      slug: slug.toLowerCase(),
      acceleratorPrice: Number(acceleratorPrice),
      badge,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[api] POST /discounts error:", err);
    return new NextResponse(err.message, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const c = await cookies();
  const cookie = c.get(AGENCY_COOKIE_NAME)?.value;
  const ok = await verifyAgencySessionCookie(cookie);
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug");
    if (!slug) return new NextResponse("Missing slug", { status: 400 });

    await deleteAcceleratorDiscount(slug);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[api] DELETE /discounts error:", err);
    return new NextResponse(err.message, { status: 500 });
  }
}
