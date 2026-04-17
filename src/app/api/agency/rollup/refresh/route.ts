import { NextResponse, after } from "next/server";
import { startRollupRefresh } from "@/lib/agency-rollup-runner";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * On Vercel serverless, a raw `void asyncThing()` is killed the moment the
 * response is sent. `after()` tells Vercel to keep the function alive until
 * the promise resolves (bounded by maxDuration). That's the only reason the
 * previous deploy always timed out: the background runner was being
 * terminated before making meaningful progress.
 *
 * `?limit=N` restricts the run to the first N active clients — useful for
 * validating end-to-end before running against the full roster.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit ? Math.max(1, parseInt(rawLimit, 10)) : undefined;

  const result = await startRollupRefresh({
    triggeredBy: "manual",
    skipIfRunning: true,
    limit,
    waitUntil: (p: Promise<void>) => after(p),
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
