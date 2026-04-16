import { NextResponse } from "next/server";
import {
  AGENCY_COOKIE_ATTRS,
  AGENCY_COOKIE_NAME,
  createAgencySessionCookie,
  isValidAgencyPassword,
} from "@/lib/agency-auth";

export async function POST(req: Request) {
  let body: { password?: string } = {};
  try {
    body = (await req.json()) as { password?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const password = String(body.password ?? "");
  if (!isValidAgencyPassword(password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  const value = await createAgencySessionCookie();
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AGENCY_COOKIE_NAME,
    value,
    ...AGENCY_COOKIE_ATTRS,
  });
  return res;
}
