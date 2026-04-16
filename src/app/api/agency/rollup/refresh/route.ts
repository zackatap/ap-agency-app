import { NextResponse } from "next/server";
import { startRollupRefresh } from "@/lib/agency-rollup-runner";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const result = await startRollupRefresh({
    triggeredBy: "manual",
    skipIfRunning: true,
  });
  if (result.status === "error") {
    return NextResponse.json(
      { error: result.message ?? "Failed to start refresh" },
      { status: 500 }
    );
  }
  const statusCode = result.status === "already-running" ? 202 : 200;
  return NextResponse.json(result, { status: statusCode });
}
