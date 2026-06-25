import { NextResponse } from "next/server";
import { isGranolaConnected } from "@/lib/granola-service";
import { countUnprocessedMeetings } from "@/lib/granola-sync-state";
import { getContentIdeasSheetUrl } from "@/lib/content-ideas-sheet";

export async function GET() {
  const connected = await isGranolaConnected();
  let pendingNewMeetings = 0;
  if (connected) {
    try {
      pendingNewMeetings = await countUnprocessedMeetings(14);
    } catch (err) {
      console.warn("[content-ideas/status] pending count failed:", err);
    }
  }
  return NextResponse.json({
    connected,
    sheetUrl: getContentIdeasSheetUrl(),
    pendingNewMeetings,
  });
}
