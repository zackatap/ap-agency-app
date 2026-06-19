import { NextResponse } from "next/server";
import { isGranolaConnected } from "@/lib/granola-service";
import { getContentIdeasSheetUrl } from "@/lib/content-ideas-sheet";

export async function GET() {
  const connected = await isGranolaConnected();
  return NextResponse.json({
    connected,
    sheetUrl: getContentIdeasSheetUrl(),
  });
}
