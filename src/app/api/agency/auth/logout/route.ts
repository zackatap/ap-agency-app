import { NextResponse } from "next/server";
import { AGENCY_COOKIE_NAME } from "@/lib/agency-auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AGENCY_COOKIE_NAME,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return res;
}
