import { NextResponse } from "next/server";
import { listGranolaMeetings } from "@/lib/granola-service";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const daysBack = Number(searchParams.get("daysBack") ?? "30");
    const meetings = await listGranolaMeetings({
      daysBack: Number.isFinite(daysBack) ? daysBack : 30,
    });
    return NextResponse.json({ meetings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list meetings";
    const status = message.includes("not connected") ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
