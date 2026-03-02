import { NextResponse } from "next/server";
import { getToken } from "@/lib/oauth-tokens";
import { getPipelines, getOpportunityCountsByStage } from "@/lib/ghl-oauth";
import { findMatchingPipeline, PAIN_PATIENTS_CONFIG } from "@/lib/pipeline-matching";
import { calculateFunnelMetrics } from "@/lib/funnel-metrics";
import { getMonthsBack } from "@/lib/date-ranges";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ locationId: string }> }
) {
  try {
    const { locationId } = await params;
    if (!locationId) {
      return NextResponse.json(
        { error: "locationId is required" },
        { status: 400 }
      );
    }

    const stored = await getToken(locationId);
    if (!stored) {
      return NextResponse.json(
        { error: "Not connected", needsAuth: true },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
          },
        }
      );
    }

    const { searchParams } = new URL(req.url);
    const pipelineId = searchParams.get("pipelineId");
    const monthsParam = searchParams.get("months");
    const monthsCount = Math.min(Math.max(parseInt(monthsParam ?? "13", 10), 1), 24);
    const clientDate = searchParams.get("clientDate") ?? undefined;

    const pipelines = await getPipelines(locationId, stored.access_token);
    const pipeline = pipelineId
      ? pipelines.find((p) => p.id === pipelineId)
      : findMatchingPipeline(pipelines, PAIN_PATIENTS_CONFIG);

    if (!pipeline) {
      return NextResponse.json({
        months: [],
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
        message: pipelineId ? "Pipeline not found" : "No matching pipeline found.",
      });
    }

    const monthRanges = getMonthsBack(monthsCount, clientDate);

    const months = await Promise.all(
      monthRanges.map(async (range) => {
        const { counts, values } = await getOpportunityCountsByStage(
          locationId,
          pipeline,
          stored.access_token,
          { startDate: range.startDate, endDate: range.endDate }
        );
        const metrics = calculateFunnelMetrics(
          counts,
          values,
          pipeline.stages ?? undefined
        );
        return {
          monthKey: range.monthKey,
          startDate: range.startDate,
          endDate: range.endDate,
          metrics,
        };
      })
    );

    return NextResponse.json({
      months,
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
    });
  } catch (err) {
    console.error("[conversions/monthly] Error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to fetch monthly metrics",
      },
      { status: 500 }
    );
  }
}
